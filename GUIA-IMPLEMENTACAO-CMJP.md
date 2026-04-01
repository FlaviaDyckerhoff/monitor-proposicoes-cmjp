# 🏛️ Guia de Implementação — Monitor CMJP (João Pessoa)

---

## Pré-requisitos

- Conta no [GitHub](https://github.com)
- Conta Gmail com verificação em duas etapas ativa
- Os 4 arquivos do monitor (já gerados):
  - `monitor.js`
  - `package.json`
  - `monitor.yml`
  - `README.md`

---

## PARTE 1 — Gerar a Senha de App do Gmail

> Se já usa o mesmo Gmail para outro monitor (PR, RO ou ALPB), pode reutilizar a mesma senha de app — pule para a Parte 2.

**1.1** Acesse [myaccount.google.com/security](https://myaccount.google.com/security)

**1.2** Confirme que **Verificação em duas etapas** está ativa.

**1.3** Na barra de busca da página, digite **"senhas de app"** e clique no resultado.

**1.4** Digite o nome `monitor-cmjp` e clique em **Criar**.

**1.5** Copie a senha de **16 letras** gerada — ela aparece só uma vez.

---

## PARTE 2 — Criar o repositório no GitHub

**2.1** Acesse [github.com](https://github.com) → clique em **"+"** → **New repository**

**2.2** Preencha:
- **Repository name:** `monitor-proposicoes-cmjp`
- **Visibility:** Private
- Deixe tudo o mais desmarcado (sem README, sem .gitignore)

**2.3** Clique em **Create repository**

---

## PARTE 3 — Fazer upload dos arquivos

**3.1** Na página do repositório recém-criado, clique em **"uploading an existing file"**

**3.2** Arraste ou selecione os 3 arquivos:
```
monitor.js
package.json
README.md
```

**3.3** No campo de commit no final da página, deixe a mensagem padrão e clique em **Commit changes**.

---

## PARTE 4 — Criar o workflow do GitHub Actions

O arquivo `monitor.yml` precisa estar numa pasta específica (`.github/workflows/`), então não pode ser feito via upload simples.

**4.1** No repositório, clique em **Add file → Create new file**

**4.2** No campo de nome do arquivo, digite exatamente:
```
.github/workflows/monitor.yml
```
(Ao digitar a primeira `/`, o GitHub vai criar a pasta automaticamente.)

**4.3** Abra o arquivo `monitor.yml` que você baixou, copie todo o conteúdo e cole na área de edição.

**4.4** Clique em **Commit changes** → **Commit changes** (confirmação).

---

## PARTE 5 — Configurar os Secrets

**5.1** No repositório: **Settings** (aba no topo) → **Secrets and variables** → **Actions**

**5.2** Clique em **New repository secret** e crie os 3 secrets abaixo, um por vez:

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail (ex: seuemail@gmail.com) |
| `EMAIL_SENHA` | a senha de 16 letras do App Password, **sem espaços** |
| `EMAIL_DESTINO` | email onde quer receber os alertas |

> Para cada secret: clique em **New repository secret** → preencha Name e Secret → **Add secret**.

---

## PARTE 6 — Testar

**6.1** Vá em **Actions** (aba no topo do repositório)

**6.2** Clique em **Monitor Proposições CMJP** na lista à esquerda

**6.3** Clique em **Run workflow** → **Run workflow** (botão verde)

**6.4** Aguarde ~15 segundos. Clique no run que apareceu para ver o log.

**6.5** Resultado esperado:
- ✅ Verde = funcionou
- O log deve mostrar algo como `📊 Total na API: 2579 proposições em 516 páginas`
- O primeiro run envia email com as 100 proposições mais recentes do ano e salva o estado
- A partir do segundo run, só envia se houver novidades

**6.6** Verifique a caixa de entrada (e o spam, no primeiro email).

> ⚠️ **Atenção no primeiro email:** a CMJP tem volume alto de REQs (requerimentos de obra, zeladoria, capinagem). O email já agrupa todos os REQs no final, separados por uma linha tracejada, para facilitar a leitura do que importa primeiro.

---

## Como funciona no dia a dia

O workflow roda automaticamente 4x por dia nos horários:

| Horário BRT | Cron UTC |
|-------------|----------|
| 08:00 | `0 11 * * *` |
| 12:00 | `0 15 * * *` |
| 17:00 | `0 20 * * *` |
| 21:00 | `0 0 * * *` |

Cada execução faz **1 chamada à API** do SAPL da CMJP = **4 chamadas/dia**.

---

## Estrutura do email

O email organiza as proposições assim:

```
PLO, PLC, VETO, INDICAÇÃO...  ← tipos prioritários, ordem alfabética
────────────────────────────
⬇️ Requerimentos (N)          ← separador visual
REQ-Obras, REQ-Informação...  ← todos os REQs no final
```

---

## Resetar o estado (forçar reenvio de tudo)

Útil para testar ou se o `estado.json` ficar corrompido:

**1.** No repositório, clique em `estado.json` → ícone de lápis (editar)

**2.** Substitua todo o conteúdo por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```

**3.** Clique em **Commit changes**

**4.** Rode o workflow manualmente (Parte 6)

---

## Problemas comuns

**Não aparece "Senhas de app" no Google**
→ Ative a verificação em duas etapas primeiro.

**Erro "Authentication failed" no log**
→ Verifique se `EMAIL_SENHA` foi colado sem espaços.

**Workflow não aparece em Actions**
→ Confirme que o arquivo está em `.github/workflows/monitor.yml` (com o ponto no início).

**Rodou verde mas não veio email**
→ Verifique o spam. Se não estiver lá, abra o log do run em Actions e procure por `❌` ou `⚠️`.

**Log mostra "0 proposições encontradas"**
→ A API do SAPL pode estar fora do ar. Teste no browser:
`https://sapl.joaopessoa.pb.leg.br/api/materia/materialegislativa/?ano=2026&page=1&page_size=5`

**Os tipos de proposição aparecem estranhos no email**
→ A CMJP usa nomes como "REQ-Obras, serviços e melhoramentos", "Projeto de Lei Ordinária", "Veto" etc. O script extrai o tipo do nome da matéria automaticamente. Se aparecer algo truncado, avise para ajustar.

**Campo "Autor" aparece como "-"**
→ Esperado. A API retorna o autor como ID numérico, não o nome. Pode ser implementado futuramente com chamada extra por proposição.
