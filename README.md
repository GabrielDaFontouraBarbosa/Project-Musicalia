# Musicalia

Jogo musical de 4 jogadores: cada um escreve uma pista num piano roll e juntas viram uma música.

- `public/index.html`: o jogo (HTML/CSS/JS puro, sons sintetizados com WebAudio).
- `src/worker.js`: servidor multiplayer (Cloudflare Worker + Durable Objects): uma sala por Durable Object via WebSocket e um lobby com as salas públicas.

## Rodar localmente

```bash
npx wrangler dev
```

## Publicar

```bash
npx wrangler deploy
```

Na Cloudflare (Workers Builds): build command vazio, deploy command `npx wrangler deploy`, root directory `/`.
