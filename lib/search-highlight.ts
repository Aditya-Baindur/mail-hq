export type TextMatch = { start: number; end: number };
export type HighlightMatches = HTMLElement[][];

/** Literal, case-insensitive phrase matching, with the index's whitespace rules. */
export function findTextMatches(text: string, query: string): TextMatch[] {
  const needle = query.replace(/\0/g, '').replace(/\s+/gu, ' ').trim().slice(0, 200);
  if (!needle) return [];
  const pattern = needle.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return Array.from(text.matchAll(new RegExp(pattern, 'giu')), (match) => ({
    start: match.index!, end: match.index! + match[0].length,
  }));
}

const blockSelector = 'address,article,aside,blockquote,div,dl,dt,dd,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,li,main,nav,ol,p,pre,section,table,td,th,tr,ul';
const ignoredSelector = 'head,script,style,template,noscript,[hidden],[aria-hidden="true"]';

/** Only call on a sanitized email document. Never interprets query text as HTML. */
export function highlightDocument(root: HTMLElement, query: string): HighlightMatches {
  const doc = root.ownerDocument;
  root.querySelectorAll('mark[data-mail-search-match]').forEach((mark) => {
    mark.replaceWith(doc.createTextNode(mark.textContent || ''));
  });
  root.normalize();
  if (!query.trim()) return [];
  const segments: { node: Text; start: number; end: number }[] = [];
  // Element visits allow <br> boundaries and pruning non-content subtrees.
  const walker = doc.createTreeWalker(root, 5, {
    acceptNode(node) {
      if (node.nodeType !== 1) return 1;
      const element = node as HTMLElement;
      if (element.matches(ignoredSelector)) return 2;
      const style = doc.defaultView?.getComputedStyle(element);
      return style?.display === 'none' || style?.visibility === 'hidden' ? 2 : 1;
    },
  });
  const parts: string[] = [];
  let length = 0;
  let previousBlock: Element | null = null;
  let boundary = false;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === 1) {
      if ((node as Element).matches('br,hr,img')) boundary = true;
      continue;
    }
    const block = node.parentElement?.closest(blockSelector) || root;
    if (boundary || block !== previousBlock) { parts.push(' '); length++; }
    boundary = false;
    previousBlock = block;
    const text = (node as Text).data;
    segments.push({ node: node as Text, start: length, end: length + text.length });
    parts.push(text);
    length += text.length;
  }
  const matches = findTextMatches(parts.join(''), query);
  const groups: HighlightMatches = matches.map(() => []);
  let firstMatch = 0;
  for (const segment of segments) {
    while (firstMatch < matches.length && matches[firstMatch].end <= segment.start) firstMatch++;
    if (firstMatch === matches.length) break;
    if (matches[firstMatch].start >= segment.end) continue;
    const fragment = doc.createDocumentFragment();
    let offset = 0;
    for (let i = firstMatch; i < matches.length && matches[i].start < segment.end; i++) {
      const start = Math.max(matches[i].start - segment.start, 0);
      const end = Math.min(matches[i].end - segment.start, segment.node.length);
      if (start >= end) continue;
      fragment.append(doc.createTextNode(segment.node.data.slice(offset, start)));
      const mark = doc.createElement('mark');
      mark.className = 'mail-search-hit';
      mark.dataset.mailSearchMatch = String(i);
      mark.textContent = segment.node.data.slice(start, end);
      fragment.append(mark);
      groups[i].push(mark);
      offset = end;
    }
    fragment.append(doc.createTextNode(segment.node.data.slice(offset)));
    segment.node.replaceWith(fragment);
  }
  return groups.filter((group) => group.length);
}

// Shared with the sandboxed email iframe, which cannot inherit application CSS.
export const highlightStyles = `mark.mail-search-hit{background:#fef08a!important;color:#422006!important;border-radius:2px;padding:0;font:inherit}mark.mail-search-hit[data-active="true"]{background:#fbbf24!important;outline:2px solid #b45309;outline-offset:1px}`;
