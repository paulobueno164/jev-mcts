@echo off
rem Laco do harness sobre o b3-market-oracle, com o MENOR modelo do CLI.
rem
rem A permissao Bash(node:*) existe por um motivo medido: com --permission-mode
rem acceptEdits sozinho o agente escreve o arquivo mas nao consegue RODAR o
rem validador, e fica pedindo aprovacao para um terminal que nao tem ninguem.
rem
rem NAO edite este arquivo enquanto ele estiver rodando: o cmd.exe rele o lote
rem pelo deslocamento em bytes e retoma no lugar errado.
setlocal
cd /d C:\projetos\jev
set LOG=C:\projetos\jev\projeto_luiz\runs\build-3.log

rem Sem o espaco antes de ">", o cmd le "===>" como redirecionamento.
echo === inicio %DATE% %TIME% === > "%LOG%"
echo rodando... a saida vai para %LOG%
echo.

call npx tsx --env-file-if-exists=.env src/cli/main.ts build ^
  --spec projeto_luiz/spec.json ^
  --agent "claude -p --model claude-haiku-4-5-20251001 --permission-mode acceptEdits --allowedTools Bash(node:*)" ^
  --evaluator jev --no-zdr --steps 12 --retries 2 --echo >> "%LOG%" 2>&1

set CODIGO=%ERRORLEVEL%
rem "EXIT=0>>" seria lido como redirecionamento do descritor 0. O espaco e obrigatorio.
echo EXIT=%CODIGO% >> "%LOG%"
echo.
echo ==== terminou com codigo %CODIGO% ====
echo 0=concluido 3=progrediu/re-chame 4=precisa de gente 2=erro de uso
echo.
pause
