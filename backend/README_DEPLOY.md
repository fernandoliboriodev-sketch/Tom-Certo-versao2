# Tom Certo Backend — Deploy no Railway

## 🎯 Objetivo
Rodar este backend FastAPI no Railway com auto-deploy via GitHub, conectado ao MongoDB Atlas.

---

## 📋 Passo 1 — Subir o código pro GitHub

Se o projeto ainda não está no GitHub, use o terminal local (no seu computador):

```bash
cd /caminho/do/projeto
git init
git add .
git commit -m "Backend Tom Certo — pronto para deploy"
git branch -M main
# Crie um repositório em github.com e cole o URL abaixo
git remote add origin https://github.com/SEU_USER/tom-certo-backend.git
git push -u origin main
```

> **Dica:** Se for subir o monorepo inteiro (frontend + backend), configure o Railway para usar apenas o subdiretório `backend/` (ver passo 3).

---

## 📋 Passo 2 — Criar projeto no Railway

1. Acesse https://railway.app → **New Project**
2. Escolha **"Deploy from GitHub repo"**
3. Autorize o Railway a acessar seu GitHub (1x apenas)
4. Selecione o repositório do backend Tom Certo
5. Railway detecta automaticamente:
   - Python (via `.python-version` + `requirements.txt`)
   - Start command (via `Procfile` / `railway.json`)

---

## 📋 Passo 3 — Se o backend estiver em subdiretório (monorepo)

Se seu repo tem estrutura tipo `/app/backend/` e `/app/frontend/`:

1. No Railway → Service Settings → **Root Directory**
2. Cole: `backend` (ou o caminho relativo ao backend)
3. Salvar

---

## 📋 Passo 4 — Configurar variáveis de ambiente

No Railway, abra seu serviço → aba **Variables** → **+ New Variable**. Adicione:

| Variável | Valor | Obs |
|----------|-------|-----|
| `MONGO_URL` | `mongodb+srv://USER:PASS@cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority` | Cole sua connection string do Atlas |
| `DB_NAME` | `tom_certo_db` | Nome do banco (opcional, default `tom_certo_db`) |
| `JWT_SECRET` | Gere com: `python -c "import secrets; print(secrets.token_urlsafe(48))"` | String aleatória longa |
| `ADMIN_USERNAME` | `admin` | Usuário do painel admin |
| `ADMIN_PASSWORD` | **senha forte** | Troque a senha padrão |

> ⚠️ **NÃO inclua** `PORT` nas variáveis — o Railway injeta automaticamente.

---

## 📋 Passo 5 — Atlas: permitir acesso do Railway

1. MongoDB Atlas → **Network Access** → **+ Add IP Address**
2. Clique **"Allow Access from Anywhere"** (`0.0.0.0/0`)
   - Necessário pois o IP do Railway é dinâmico
3. Salvar

---

## 📋 Passo 6 — Testar o deploy

Após o deploy, Railway te dá uma URL pública tipo `https://tom-certo-production.up.railway.app`.

### Testar health:
```bash
curl https://SUA_URL.up.railway.app/health
# Resposta esperada: {"status":"OK","db":"connected"}
```

### Testar validação de token:
```bash
curl -X POST https://SUA_URL.up.railway.app/api/auth/validate \
  -H "Content-Type: application/json" \
  -d '{"token":"TEST-DEV2026","device_id":"test-device-001"}'
```

### Testar admin login:
```bash
curl -X POST https://SUA_URL.up.railway.app/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"SUA_SENHA"}'
```

---

## 📋 Passo 7 — Apontar o APK para o novo backend

Depois que o Railway funcionar, me passe a URL pública. Eu:
1. Atualizo `EXPO_PUBLIC_BACKEND_URL` no frontend
2. Publico via **OTA update** (`eas update --channel preview`)
3. Seu APK instalado passa a usar o Railway em **30 segundos**, sem precisar de novo build

---

## 🔒 Boas práticas

- ✅ **Nunca** commitar `.env` real
- ✅ Trocar `ADMIN_PASSWORD` padrão
- ✅ Usar `JWT_SECRET` aleatório (64+ caracteres)
- ✅ Monitorar logs no Railway (aba **Logs**)
- ✅ Habilitar alertas de erro no Railway

---

## 🚀 Deploy contínuo

Depois de configurado, cada `git push origin main` dispara um novo deploy automático no Railway. Zero trabalho manual.

---

## 📞 Endpoints úteis

- `GET /health` — health check (público)
- `GET /api/health` — health check (via /api)
- `POST /api/auth/validate` — valida token do APK
- `POST /api/auth/revalidate` — revalida sessão
- `POST /api/admin/login` — login do painel admin
- `GET /api/admin/tokens` — listar tokens (admin)
- `POST /api/admin/tokens` — criar token (admin)
- `GET /api/admin-ui` — painel web de gestão
