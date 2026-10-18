// Test-only (item 280): remove comentários de um arquivo JS/JSX para as guardas
// de vocabulário, usando o parser do TypeScript (já devDependency — é o
// `npm run typecheck`). Um leitor caseiro por regex confundia `/*` e `//`
// dentro de string, template aninhado, regex e texto JSX, e escondia código
// real da varredura (achados das revisões do PR-E2/E3). O parser sabe o que é
// comentário de verdade: `<p>TP1 // TP2</p>` é texto JSX, não comentário.
import ts from 'typescript';

/**
 * Troca cada comentário por espaços, preservando as quebras de linha (os
 * números de linha das mensagens continuam batendo com o arquivo).
 * @param {string} source
 * @param {string} [fileName]
 */
export function stripComments(source, fileName = 'x.jsx') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const ranges = new Map();
  const jsxText = [];
  const collect = (list) => { for (const r of list ?? []) ranges.set(r.pos, r.end); };
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end]);
    collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(source, node.getEnd()));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  // getLeading/TrailingCommentRanges leem o texto cru: depois de um `{expr}`,
  // um `//` dentro do texto JSX seguinte parece comentário. Texto JSX nunca é
  // comentário (achado da 3ª revisão).
  const inJsxText = (pos) => jsxText.some(([a, b]) => pos >= a && pos < b);
  let out = source;
  for (const [pos, end] of ranges) {
    if (inJsxText(pos)) continue;
    out = out.slice(0, pos) + out.slice(pos, end).replace(/[^\n]/g, ' ') + out.slice(end);
  }
  return out;
}
