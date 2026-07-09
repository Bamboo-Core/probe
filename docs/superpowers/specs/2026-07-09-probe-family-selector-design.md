# Design — Seletor de família IPv4/IPv6 no `probe` (sub-projeto #1)

**Data:** 2026-07-09
**Repo:** `probe` (ISP Tools Probe — Fastify, ES modules, port 8000)
**Status:** aprovado (design) — pendente escrita do plano de implementação

---

## Contexto: o feature maior e a decomposição

Objetivo do produto: o dashboard do **Probe-Service** deve coletar e exibir dados de
**IPv4 e IPv6** para cada endereço monitorado, em todos os módulos da tela (o exemplo do
usuário: `drive.google.com → IPv4: 142.4 ms / IPv6: <ms>`).

Isso atravessa 3 repositórios independentes. Decidimos decompor em **3 sub-projetos**,
cada um com seu próprio spec → plano → implementação, na ordem:

1. **`probe` (ESTE spec)** — cada módulo baseado em resolução ganha um seletor de família
   `?family=4|6`. É o alicerce: sem forçar a família na sonda, nada a montante consegue
   distinguir v4 de v6.
2. **`probe-collector` + migrations (Kuanticks)** — `ip_version` vira dimensão de 1ª classe:
   seeding v4+v6, coluna nas tabelas, unique key, queries/analytics, `/overview` devolvendo
   as duas famílias por endereço. (spec futuro no repo `probe-collector`.)
3. **`Probe-Service` (UI)** — cards (`IPv4: X / IPv6: Y`), gráficos e consultas on-demand
   exibindo as duas famílias. (spec futuro no repo `Probe-Service`.)

Decisões transversais já fechadas com o usuário:
- **Mecanismo:** o probe ganha `?family=4|6` (dimensão `ip_version` de 1ª classe a montante).
  Rejeitadas: (b) coletor resolve e manda IP literal — quebra o `Host`/SNI do módulo `http`;
  (c) só em params/JSONB sem coluna — colide com a unique key `(probe_id, module, target)`.
- **Cobertura:** sonda as duas famílias em **todos** os 50 endereços do catálogo. Quem não
  tem `AAAA` (ou é literal v4 como `1.1.1.1`) simplesmente mostra "sem IPv6 / —". Sem
  curadoria de catálogo, sem lógica condicional de agendamento.

Este spec cobre **somente o sub-projeto #1**.

---

## Estado atual do `probe` (o que já existe)

- Módulos são **auto-descobertos** por `loader.js` (`modules/*/main.js` exportando
  `{route, method, middleware?, handler}`). Sem registro central.
- **Cada módulo baseado em resolução tem seu próprio `resolveHost(host)`** que faz
  `dns.resolve4()` e, em falha, cai para `dns.resolve6()` (ex.: `modules/ping/main.js:28-40`).
  Um hostname, portanto, **sempre** resolve para IPv4 hoje (só usa v6 quando não há A).
- O `handler` recebe `request.query` (o `ping` inclusive já ecoa `query` na resposta —
  `modules/ping/main.js:203,210,228`). Ler `?family=` é trivial.
- A resposta de cada módulo **já reporta `ipVersion`** (0/4/6) e o IP efetivamente usado
  (`target`/`targetIP`). As libs de baixo nível já suportam v6: `raw-socket` ICMPv6
  (traceroute/smokeping/mtu), `dgram` `udp6` (portscan), `dns.resolve6`.
- `global.ipv4Support` / `global.ipv6Support` são autodetectados (`register.js`). O `ping`
  já trata um caso `'ipv6-only (disabled)'` → `IPv6NotSupportedError`
  (`modules/ping/main.js:195-196`).

**Lacuna:** não há como forçar a família por requisição — nem query param, nem rota
separada. É essa lacuna, e só ela, que este sub-projeto fecha.

---

## Design

### Contrato do parâmetro `family`

Novo query param **opcional** `family`, aceito por todos os módulos baseados em resolução:

| `family` | Comportamento |
|---|---|
| `4`   | Resolve **só** registros `A`. Sem `A` → erro `HostNotFoundError`, `ipVersion: 0`. |
| `6`   | Resolve **só** registros `AAAA`. Sem `AAAA` → erro `HostNotFoundError`, `ipVersion: 0`. Se `global.ipv6Support === false` → `IPv6NotSupportedError`, `ipVersion: 0`. |
| ausente / valor inválido | **Comportamento atual** (v4-first, fallback v6). Compatibilidade total. |

- Literal IP como alvo: se o literal contradiz a família pedida (ex.: `1.1.1.1?family=6`),
  trata como "família indisponível" → `HostNotFoundError`, `ipVersion: 0`. Se combina
  (ex.: `2606:4700:4700::1111?family=6`), usa o literal normalmente.
- **Opt-in e retrocompatível:** sem `family`, absolutamente nada muda para consumidores
  atuais (incluindo o coletor de hoje).

### Onde muda

Um helper puro compartilhado + uma pequena mudança no `resolveHost` de cada módulo.

1. **Helper compartilhado** `parseFamily(query)` (novo módulo no root, ex.: `family.js`,
   junto de `auth.js`/`metrics.js`, importado dos módulos como `../../family.js`):
   retorna `4`, `6` ou `null` a partir de `query.family`. Puro, sem I/O, trivialmente
   testável por inspeção. É a **única** peça compartilhada nova.

2. **`resolveHost(host)` → `resolveHost(host, family)`** em cada módulo baseado em resolução:
   - `family === 4`: só `dns.resolve4` (não cai para v6).
   - `family === 6`: só `dns.resolve6`, respeitando `global.ipv6Support` (retorna
     `IPv6NotSupportedError` quando a VM não tem egress v6).
   - `family` nulo: fluxo atual inalterado.
   - Para literais (`net.isIP`), valida contra a família pedida.

3. **Handler de cada módulo**: `const family = parseFamily(request.query); ... resolveHost(input, family)`.

**Módulos tocados (6, baseados em resolução):** `ping`, `http`, `traceroute`, `mtu`,
`portscan`, `smokeping`.

- **`http` (caso especial):** forçar a família afeta **só** qual IP é usado na conexão
  (opção de socket `family`), mantendo **`Host`/SNI = hostname**. O módulo já deriva a
  opção de socket a partir da versão resolvida; a mudança é só respeitar a preferência de
  família na resolução, sem tocar no `Host`.

**Módulo fora de escopo:** `dns` — é on-demand e **já** separa por `?method=A|AAAA`;
não usa `resolveHost` para o dado principal. Nenhuma mudança.

### Tratamento de erro / forma da resposta

- Campos atuais permanecem (`ipVersion`, `target`/`targetIP`, `err`, etc.). `ipVersion` já
  reflete a família efetivamente usada.
- Família pedida inexistente → resposta com `ipVersion: 0` e `err` claro
  (`HostNotFoundError` ou `IPv6NotSupportedError`). O coletor (sub-projeto #2) mapeia isso
  para `status = error`, e a UI (sub-projeto #3) renderiza "sem IPv6 / —".
- Nenhum código HTTP novo: erros de resolução continuam sendo 200 com `err` no corpo
  (padrão atual do probe).

### Fora de escopo (YAGNI)

- **Não** extrair um resolver unificado entre os módulos. Os `resolveHost` divergem
  (ex.: cache de DNS no `ping`); unificar arrisca desvio de comportamento sem ganho para
  este objetivo. A duplicação fica; só o `parseFamily` é compartilhado.
- **Não** adicionar rotas novas (ex.: `/ping/ipv6/...`). O param cobre o caso com menos
  superfície.
- **Não** mexer no `dns` nem em métricas Prometheus além do que já existe (elas já recebem
  `version`).

---

## Verificação

Não há suíte de testes automatizada no repo (CLAUDE.md). Verificação por **smoke test**
com o probe rodando (`npm run dev`, porta 8000):

- `GET /ping/www.google.com` → inalterado, `ipVersion: 4`.
- `GET /ping/www.google.com?family=6` → `ipVersion: 6`, `ms` preenchido.
- `GET /ping/1.1.1.1?family=6` → `err: HostNotFoundError`, `ipVersion: 0`.
- `GET /ping/www.google.com?family=4` → `ipVersion: 4`.
- Repetir para `http`, `traceroute`, `mtu`, `portscan`, `smokeping` com `family=4` e `family=6`
  contra um host com dual-stack (ex.: `www.google.com`) e um só-v4 (`1.1.1.1`).
- Confirmar retrocompat: qualquer chamada **sem** `family` produz saída idêntica à atual.

---

## Próximos passos

1. Escrever o plano de implementação deste sub-projeto (skill `writing-plans`).
2. Após implementado e verificado, brainstorm + spec do **sub-projeto #2** (`probe-collector`
   + migrations), depois do **#3** (`Probe-Service` UI).
