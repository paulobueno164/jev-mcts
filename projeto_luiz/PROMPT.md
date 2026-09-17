# B3 Market Oracle — enunciado original

> Texto recebido, reproduzido sem alteração. É a fonte da tarefa; o que vale como
> entrega está em `CONTRATO.md`, e o que vale como verdade está em
> `tools/validar.mjs`.

---

**B3 Market Oracle: High-Dimensional Feature Extraction Tensor**

System Specification & Institutional Question Registry for Brazilian Capital Markets

Target Domain: Brazilian Capital Markets (B3, CVM Disclosures, Diário Oficial da União, Administrative & Tax Courts)

Architecture: Zero Context-Rot Parallel Discriminative Perception Tensor (TypeSafe Jev)

Output Representation: Dense Numerical Feature Vector (\mathbb{R}^{D}, D \approx 320) per Corporate Event

Downstream Application: High-Dimensional Quantitative Feature Store, Historical Training of Multimodal Temporal Neural Networks, Tabular Ensembles (XGBoost/CatBoost), and Event-Driven Alpha Models.

## 1. Architectural Paradigm: The Market Oracle

Instead of coupling perception directly to immediate trading execution rules, the Market Oracle acts as a pure, loss-minimized semantic feature extractor.

Every unstructured corporate disclosure (CVM Fato Relevante, Comunicado ao Mercado, Aviso aos Acionistas, earnings release, CADE resolution, or judicial decree) is evaluated across an exhaustive, orthogonal battery of discriminative perception heads in parallel.
