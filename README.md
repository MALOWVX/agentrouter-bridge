# AgentRouter Bridge — Disguise Proxy

Proxy qui intercepte les requêtes de **JanitorAI** et les transforme pour qu'elles semblent venir de **Claude Code CLI** avant de les relayer vers [AgentRouter.org](https://agentrouter.org).

## 🚀 Déploiement sur Railway

### 1. Créer le projet Railway

1. Va sur [railway.app](https://railway.app) et connecte-toi
2. Clique **"New Project"** → **"Deploy from GitHub repo"**
3. Sélectionne ton repo contenant ce dossier `agentrouter-bridge`
4. Railway détecte automatiquement le `Dockerfile` et déploie

### 2. Variables d'environnement (Railway)

Dans les settings de ton service Railway, ajoute :

| Variable | Valeur | Requis ? |
|---|---|---|
| `AGENTROUTER_BASE_URL` | `https://agentrouter.org` | Optionnel (c'est le défaut) |
| `DISGUISE_MODE` | `claude-code` | Optionnel (c'est le défaut) |
| `PORT` | *(Railway le set automatiquement)* | Non |

> **Note :** Tu n'as PAS besoin de mettre ta clé API ici — elle sera passée depuis JanitorAI.

### 3. Configurer JanitorAI

Une fois ton proxy déployé sur Railway (tu obtiendras une URL du type `https://ton-app.up.railway.app`), configure JanitorAI :

- **API URL** : `https://ton-app.up.railway.app/v1`
- **API Key** : Ta clé AgentRouter (`sk-...`)
- **Model** : `claude-opus-4-8`, `claude-opus-5`, ou `gpt-5.6-sol`

## 🖥️ Lancer en local (pour tester)

```bash
cd agentrouter-bridge
npm install
npm start
```

Le proxy démarre sur `http://localhost:3131`.

Configure JanitorAI avec :
- **API URL** : `http://localhost:3131/v1`
- **API Key** : Ta clé AgentRouter

## 🎭 Modes de déguisement

Le proxy supporte 3 modes, configurable via `DISGUISE_MODE` :

| Mode | Description | Recommandé ? |
|---|---|---|
| `claude-code` | Se fait passer pour Claude Code CLI | ✅ **Oui** |
| `cursor` | Se fait passer pour Cursor IDE | Backup |
| `codex` | Se fait passer pour Codex CLI | Backup |

Change de mode en modifiant `DISGUISE_MODE` dans les variables d'environnement Railway.

## 🔍 Endpoints

| Méthode | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | Proxy principal (OpenAI-compatible) |
| `GET` | `/v1/models` | Liste des modèles disponibles |
| `GET` | `/health` | Healthcheck (utilisé par Railway) |
| `GET` | `/` | Info page |

## 📊 Comment ça marche

```
JanitorAI  ─────►  Bridge Proxy  ─────►  AgentRouter.org
                     (Railway)
  1. Envoie requête     2. Supprime les          3. Forward avec
     OpenAI-compatible     headers JanitorAI        headers Claude Code
                           Injecte identité
                           Claude Code CLI

AgentRouter.org  ─────►  Bridge Proxy  ─────►  JanitorAI
                          (Railway)
  4. Répond normalement   5. Relaye la réponse    6. Affiche la
     (croit que c'est       (streaming SSE          réponse normalement
      Claude Code)          supporté)
```

## ⚠️ Troubleshooting

- **401 Unauthorized** → Vérifie ta clé API AgentRouter dans JanitorAI
- **502 Bad Gateway** → AgentRouter est peut-être down, réessaie
- **Streaming ne marche pas** → Assure-toi que JanitorAI envoie `"stream": true` dans la requête
- **Changer de mode** → Modifie `DISGUISE_MODE` dans Railway et redéploie
