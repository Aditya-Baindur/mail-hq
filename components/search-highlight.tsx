import { Fragment } from 'react';
import { findTextMatches } from '../lib/search-highlight';

export function HighlightedText({ text, query }: { text: string; query: string }) {
  const matches = findTextMatches(text, query);
  let offset = 0;
  return <>{matches.map(({ start, end }, index) => {
    const before = text.slice(offset, start);
    offset = end;
    return <Fragment key={start}>{before}<mark className="mail-search-hit" data-mail-search-match={index}>{text.slice(start, end)}</mark></Fragment>;
  })}{text.slice(offset)}</>;
}
