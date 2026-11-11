# Logos dos tokens (`src/assets/tokens/`)

Os arquivos `<TICKER>.svg` (ex.: `BTC.svg`) são os logos que o componente `src/components/TokenIcon.jsx` mostra ao lado do nome do token no painel
(Agenda de eventos, cartões de ativo, operações, alertas, busca…). O nome do arquivo é o TICKER em maiúsculas, sem a moeda de cotação (`BTC`, não `BTCUSDT`).

- **Origem:** pacote `@web3icons/core` 4.0.59 (npm), variante `background` (logo sobre um fundo colorido; o painel arredonda e põe um anel fino).
  A licença declarada no `package.json` do pacote é **MIT**. Os SVGs foram copiados como texto, conferidos (sem `<script>`, sem `on*=`, sem imagem nem link externo) e
  nenhum código do pacote é executado nem instalado como dependência do projeto.
- **Marcas:** cada logo pertence ao respectivo projeto (marca registrada de quem a criou). Aqui só serve para IDENTIFICAR o ativo, sem sugerir parceria nem endosso.
- **Sem logo na pasta** (ZRO, ENA, ETHFI, ONDO, INJ, EIGEN no dia da cópia): o painel mostra uma bolinha colorida com a inicial (nada quebra, nem token novo).
- **Acrescentar um token:** copie o SVG para esta pasta com o nome do ticker em maiúsculas (ex.: `ENA.svg`) e acrescente o ticker à lista de `src/components/TokenIcon.test.jsx`
  (o teste confere que a pasta e a lista são iguais, para nenhum logo sumir nem entrar por engano). O Vite embute os SVGs pequenos e emite os maiores como arquivos
  separados; só são baixados os logos que aparecem na tela.
