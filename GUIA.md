# The Indie Index — Portal de jogos (guia de instalação)

Tudo roda de graça no Cloudflare (você já usa o Pages). Nenhum token do GitHub é necessário.

## Como funciona

```
Navegador ──► Cloudflare Pages (site estático em /public)
          └─► Cloudflare Pages Functions (/functions/api)  ← aqui ficam as chaves secretas
                 ├─ Login Google (verificado no servidor, sessão em cookie HttpOnly)
                 ├─ lê a página do itch.io/Steam  →  filtros automáticos  →  Gemini (rodízio de chaves/modelos)
                 └─ banco D1 (SQLite gratuito do Cloudflare): jogos, fila de revisão, limites diários
```

Fluxo do dev: **entra com Google → digita nome + link → "Analyze"** → aprovado (pré-visualiza e publica) ou reprovado (vê o motivo).
Se a leitura da página ou **todas** as chaves/modelos do Gemini falharem, aparece o **formulário manual** (descrição, tags, capa).
Envios manuais ficam numa **fila** em `/admin.html` e só aparecem no catálogo depois que você aprova.

## Passo a passo (≈ 20 min)

### 0. Revogue os tokens que você postou no chat
Os dois tokens `ghp_...` ficaram expostos. Acesse github.com → Settings → Developer settings → Personal access tokens → **Delete** nos dois. O novo sistema não usa GitHub como banco, então não precisa de substituto.

### 1. Suba o projeto no GitHub
Envie **esta pasta inteira** (`public/`, `functions/`, `schema.sql`…) para o repositório (pode ser o `theindieindexgames`, mantenha-o **privado** ou público — não há segredos nos arquivos).

### 2. Conecte ao Cloudflare Pages
Cloudflare → Workers & Pages → seu projeto `theindieindex` → Settings → conecte ao repositório do GitHub.
- Framework preset: **None** · Build command: *(vazio)* · Build output directory: **`public`**

> Importante: as Functions (a API) só são publicadas pela integração com Git (ou `wrangler`). Arrastar uma pasta na tela de "Direct Upload" **não** compila a pasta `functions/`.
> Se o seu projeto atual foi criado por upload, crie um projeto novo ligado ao Git (pode manter o nome, apagando o antigo).

### 3. Crie o banco D1
Cloudflare → Storage & Databases → **D1** → Create → nome `indie-index`.
Abra a aba **Console**, cole o conteúdo de `schema.sql` e clique em **Execute**.
Depois: Pages → seu projeto → Settings → **Bindings** → Add → **D1 database** → variable name **`DB`** → escolha `indie-index`.

### 4. Login com Google (grátis)
1. console.cloud.google.com → crie um projeto → **APIs & Services → OAuth consent screen** → External → preencha nome/e-mail → depois clique em **Publish app** (para qualquer pessoa conseguir entrar; só pede nome/e-mail/foto, não exige verificação).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Em *Authorized JavaScript origins* coloque `https://theindieindex.pages.dev` (e seu domínio próprio, se tiver). Não precisa de redirect URI.
4. Copie o **Client ID** (termina em `.apps.googleusercontent.com`).

### 5. Chave(s) do Gemini (grátis)
aistudio.google.com/apikey → Create API key.
**Atenção:** o limite gratuito do Gemini é **por projeto, não por chave**. Duas chaves do *mesmo* projeto compartilham a cota. O rodízio só ajuda se as chaves forem de projetos diferentes — e criar contas/projetos só para burlar limite pode violar os termos do Google. O sistema já tem uma proteção melhor: **modelo reserva** (`gemini-2.5-flash` → `gemini-2.5-flash-lite`), limite diário por usuário e uma cota global; ao estourar, cai no formulário manual.

### 6. Variáveis de ambiente
Pages → Settings → **Variables and Secrets** (Production), cadastre:

| Nome | Tipo | Valor |
|---|---|---|
| `GOOGLE_CLIENT_ID` | texto | o Client ID do passo 4 |
| `ADMIN_EMAILS` | texto | seu e-mail do Google (vários: separados por vírgula) |
| `SESSION_SECRET` | **secret** | texto aleatório longo (ex.: rode `openssl rand -hex 32`, ou use um gerador de senha de 40+ caracteres) |
| `GEMINI_API_KEYS` | **secret** | `chaveA,chaveB` (separadas por vírgula; pode ser só uma) |
| `GEMINI_MODELS` | texto (opcional) | `gemini-2.5-flash,gemini-2.5-flash-lite` — confira no AI Studio os modelos disponíveis no seu plano gratuito |
| `DAILY_ANALYSES_PER_USER` | texto (opcional) | padrão 15 |
| `DAILY_SUBMISSIONS_PER_USER` | texto (opcional) | padrão 5 |
| `DAILY_ANALYSES_GLOBAL` | texto (opcional) | padrão 300 (ajuste à cota que o AI Studio mostrar) |

Faça um novo deploy (Deployments → Retry deployment) para as variáveis valerem.

### 7. Teste
Abra o site → **SUBMIT GAME** → entre com Google → envie um jogo seu. Abra `/admin.html` para ver a fila de revisão.

## Ajustando a curadoria

Edite **`functions/_lib/criteria.js`**. Lá você liga/desliga cada regra (visual novel, arte/texto por IA, spam, adulto) e pode escrever **regras próprias** em inglês na lista `custom`.
Se mudar as regras, atualize também o aviso "Not accepted" em `public/index.html`.

Camadas de proteção contra spam: (1) rejeição automática por palavras (visual novel etc.) sem gastar IA; (2) Gemini, que recebe a página como *dado não confiável* (resistente a "ignore as instruções acima" escritas na página); (3) fila manual para tudo que não passou pela IA; (4) limites diários; (5) você remove qualquer jogo logo no catálogo (botão **Remove**, só aparece para admin).

## Rodar os testes (opcional, precisa de Node 22+)
```
npm test
```
Cobrem login, CSRF, rodízio de chaves/modelos, fila manual, limites, tickets adulterados, anti-SSRF, etc.

## Estrutura
```
public/      site (index.html, trailers.html = seu formulário antigo do YouTube, admin.html, css, js)
functions/   API (api/[[route]].js) e módulos (_lib/)
schema.sql   tabelas do D1
tests/       testes automatizados
```
