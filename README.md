# Musicalia

Um loop de 1 a 8 compassos com cinco pistas (bateria, baixo, teclas, melodia e cordas), escrito num piano roll. Os sons são sintetizados com WebAudio: não há samples.

## Modos

- **Sozinho (Estúdio):** a CPU toca as outras pistas e você edita qualquer uma. Salva no aparelho, exporta/importa arquivo `.json` e baixa WAV.
- **Multiplayer:** lobby público, salas com código de 4 letras e até 5 jogadores. O modo é escolhido ao criar a sala:
  - **Jam livre:** sem relógio. Permissões: cada um no seu instrumento, pedir permissão para mexer na pista dos outros, ou livre (todo mundo mexe em tudo).
  - **Time Attack:** intro com o nome e o instrumento de cada jogador, depois um tempo curto para fazer a pista.
  - **Telefone sem fio:** o jogo gera uma melodia; numa ordem sorteada, cada um ouve só a versão anterior e tenta copiar. No fim, a corrente inteira é revelada com a porcentagem de acerto.

## Código

- `public/index.html`: o jogo (HTML/CSS/JS puro, organizado em módulos: áudio, sequenciador, arquivos, interface, editor, rede, lobby, modos de jogo).
- `public/vendor/gsap.min.js`: GSAP 3.12.5 (animações da intro). Os ícones são do Lucide, embutidos no HTML.
- `src/worker.js`: servidor multiplayer (Cloudflare Worker + Durable Objects): uma sala por Durable Object via WebSocket e um lobby com as salas públicas. O servidor controla o relógio, sorteia a ordem e só envia a melodia para quem está na vez.

## Rodar localmente

```bash
npx wrangler dev
```

## Publicar

```bash
npx wrangler deploy
```

Na Cloudflare (Workers Builds): build command vazio, deploy command `npx wrangler deploy`, root directory `/`.
