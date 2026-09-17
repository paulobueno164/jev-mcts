# Janela de acompanhamento do `jev build`.
#
# Nao decide nada e nao escreve nada: le o log do harness, o processo do agente e
# roda as MESMAS sondas do spec, de fora, para quem esta olhando ver cor e nao
# promessa. Fechar esta janela nao para a corrida.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\acompanhar.ps1

$ErrorActionPreference = 'SilentlyContinue'
$raiz = Split-Path -Parent $PSScriptRoot
$host.UI.RawUI.WindowTitle = 'jev build - b3-market-oracle'

$cpuAnterior = @{}
$ioAnterior = @{}
$ciclo = 0
$sondas = @('heads', 'registry', 'vetor')
$cores  = @{}
foreach ($s in $sondas) { $cores[$s] = 'nao medido ainda' }

function Fmt-Bytes($n) {
    if ($n -ge 1MB) { return ('{0:N1} MB' -f ($n / 1MB)) }
    if ($n -ge 1KB) { return ('{0:N1} KB' -f ($n / 1KB)) }
    return ("$n B")
}

while ($true) {
    $ciclo++

    # sempre o log mais recente: uma corrida nova nao deve deixar a janela olhando
    # para o log da corrida anterior e mostrando um retrato velho como se fosse agora.
    $log = $null
    $ultimo = Get-ChildItem (Join-Path $raiz 'runs') -Filter 'build-*.log' -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($ultimo) { $log = $ultimo.FullName }

    # --- o processo do agente ------------------------------------------------
    # O agente do harness, nao qualquer claude aberto na maquina: so o processo
    # que foi lancado em modo -p com um --model na linha e nosso.
    $alvo = Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '* -p *--model *' } |
            Sort-Object CreationDate -Descending | Select-Object -First 1
    $agente = $null
    if ($alvo) { $agente = Get-Process -Id $alvo.ProcessId -ErrorAction SilentlyContinue }

    $linhaAgente = 'nenhum processo claude vivo'
    $pulso = ''
    if ($agente) {
        $cpu = [math]::Round($agente.CPU, 1)

        # O melhor sinal de vida nao e CPU: um agente esperando a API fica com CPU
        # parada enquanto os tokens chegam. O que nao para sao as operacoes de I/O.
        $wp = Get-CimInstance Win32_Process -Filter "ProcessId=$($agente.Id)"
        $io = 0
        if ($wp) { $io = [int64]$wp.ReadOperationCount + [int64]$wp.WriteOperationCount + [int64]$wp.OtherOperationCount }

        $antIo = $ioAnterior[$agente.Id]
        if ($null -ne $antIo) {
            $dIo = $io - $antIo
            $dCpu = [math]::Round($cpu - $cpuAnterior[$agente.Id], 1)
            if ($dIo -gt 0) { $pulso = "PULSO: +$dIo operacoes de I/O e +${dCpu}s de CPU desde o refresh anterior -> VIVO" }
            else { $pulso = 'PULSO: nenhuma operacao de I/O neste intervalo -> pode estar travado' }
        }
        $cpuAnterior[$agente.Id] = $cpu
        $ioAnterior[$agente.Id] = $io

        $vivo = [math]::Round(((Get-Date) - $agente.StartTime).TotalSeconds)
        $mem  = Fmt-Bytes $agente.WorkingSet
        $linhaAgente = "pid $($agente.Id)  vivo ha ${vivo}s  cpu ${cpu}s  mem $mem"
    }

    # --- sondas, de fora, a cada ~15s ---------------------------------------
    if ($ciclo -eq 1 -or ($ciclo % 5) -eq 0) {
        foreach ($s in $sondas) {
            $saida = & node (Join-Path $raiz 'tools\validar.mjs') '--fase' $s 2>&1
            if ($LASTEXITCODE -eq 0) {
                $ok = ($saida | Select-String -Pattern '^\s+ok: ' | ForEach-Object { $_.Line.Trim() }) -join ' | '
                $cores[$s] = "VERDE   $ok"
            } else {
                $prim = ($saida | Select-String -Pattern '^\s+- ' | Select-Object -First 1)
                $txt = 'sem detalhe'
                if ($prim) { $txt = $prim.Line.Trim() }
                $cores[$s] = "VERMELHA  $txt"
            }
        }
    }

    # --- desenha -------------------------------------------------------------
    Clear-Host
    Write-Host ''
    Write-Host ('  jev build - b3-market-oracle            ' + (Get-Date -Format 'HH:mm:ss')) -ForegroundColor White
    Write-Host ('  ' + ('=' * 86)) -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  AGENTE (quem escreve)' -ForegroundColor Cyan
    Write-Host "    $linhaAgente"
    if ($pulso) {
        $corPulso = 'DarkGray'
        if ($pulso -like '*travado*') { $corPulso = 'Yellow' }
        Write-Host "    $pulso" -ForegroundColor $corPulso
    }
    Write-Host ''
    Write-Host '  SONDAS (quem decide) - lidas desta janela, nao copiadas do log' -ForegroundColor Cyan
    foreach ($s in $sondas) {
        $v = $cores[$s]
        $cor = 'Yellow'
        if ($v.StartsWith('VERDE')) { $cor = 'Green' }
        elseif ($v.StartsWith('VERMELHA')) { $cor = 'Red' }
        $recorte = $v
        if ($recorte.Length -gt 82) { $recorte = $recorte.Substring(0, 82) + '...' }
        Write-Host ("    {0,-9} {1}" -f $s, $recorte) -ForegroundColor $cor
    }
    Write-Host ''
    Write-Host '  ARTEFATOS' -ForegroundColor Cyan
    foreach ($f in @('registry\heads.json', 'registry\questions.json', 'src\extrair.mjs')) {
        $p = Join-Path $raiz $f
        if (Test-Path $p) {
            $i = Get-Item $p
            Write-Host ("    {0,-24} {1,10}   escrito {2}" -f $f, (Fmt-Bytes $i.Length), $i.LastWriteTime.ToString('HH:mm:ss')) -ForegroundColor Green
        } else {
            Write-Host ("    {0,-24} {1,10}" -f $f, 'ausente') -ForegroundColor DarkGray
        }
    }
    Write-Host ''
    $nomeLog = '(nenhum)'
    if ($log) { $nomeLog = Split-Path -Leaf $log }
    Write-Host "  LOG DO HARNESS ($nomeLog, ultimas linhas)" -ForegroundColor Cyan
    if ($log -and (Test-Path $log)) {
        Get-Content $log -Tail 14 -Encoding UTF8 | ForEach-Object { Write-Host ('    ' + $_) -ForegroundColor Gray }
    } else {
        Write-Host '    (ainda nao existe)' -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host '  ctrl+c fecha esta janela. A corrida continua.' -ForegroundColor DarkGray

    Start-Sleep -Seconds 3
}
