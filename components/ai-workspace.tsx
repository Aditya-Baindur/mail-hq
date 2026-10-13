'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Inbox, Plus, RefreshCw, Sparkles, Square, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { TooltipProvider } from './ui/tooltip';
import { EmailPreview } from './message-reader';
import { api, dateLabel, ErrorNote, Modal, Spinner, type Bootstrap, type Mail } from './shared';

type Filter = { id: string; mailbox_id: string; name: string; instructions: string; folder: string; threshold: number; version: number };
type Stats = { total: number; checked: number; pending: number; matched: number; truncated: number };
type Results = { filter: { id: string; name: string; version: number }; stats: Stats; messages: (Mail & { probability: number })[]; nextOffset: number | null };
const initial = { name: '', instructions: '', mailboxId: '', folder: 'inbox', threshold: 0.8 };
const examples = [
  { name: 'Interview requests', instructions: 'Actual invitations or requests to schedule a job interview, recruiter screening call, or hiring-manager conversation. Exclude job listings, interview advice, newsletters, and rejection emails.' },
  { name: 'Needs my reply', instructions: 'A person directly asking me a question, requesting a decision, or waiting for my response. Exclude marketing, automated notifications, and messages that only share information.' },
  { name: 'Invoices to pay', instructions: 'An invoice or payment request that asks me to pay an outstanding amount. Exclude receipts for payments already completed, promotions, and general billing announcements.' },
];

export default function AiWorkspace() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [selected, setSelected] = useState<Filter | null>(null);
  const [form, setForm] = useState(initial);
  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<Mail | null>(null);
  const [previewId, setPreviewId] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const stop = useRef(false);
  const mounted = useRef(false);
  const resultGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void Promise.all([api<Bootstrap>('/bootstrap', { signal: controller.signal }), api<{ filters: Filter[] }>('/ai/filters', { signal: controller.signal })])
      .then(([data, saved]) => {
        if (controller.signal.aborted) return;
        setBootstrap(data); setFilters(saved.filters);
        setForm(value => ({ ...value, mailboxId: data.mailboxes.find(b => b.status === 'active')?.id || '' }));
      }).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; stop.current = true; controller.abort(); resultGeneration.current++; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null); setPreviewError('');
    if (previewId) void api<Mail>(`/messages/${encodeURIComponent(previewId)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPreview(value); })
      .catch(e => { if (!controller.signal.aborted) setPreviewError(e.message); });
    return () => controller.abort();
  }, [previewId]);

  async function loadResults(filter: Filter, offset = 0) {
    const generation = ++resultGeneration.current;
    setLoadingResults(true);
    try {
      const page = await api<Results>(`/ai/filters/${filter.id}/results?offset=${offset}`);
      if (!mounted.current || generation !== resultGeneration.current) return;
      setResults(old => ({ ...page, messages: offset && old?.filter.id === filter.id ? [...old.messages, ...page.messages] : page.messages }));
    } finally { if (mounted.current && generation === resultGeneration.current) setLoadingResults(false); }
  }
  function choose(filter: Filter | null) {
    resultGeneration.current++;
    setSelected(filter); setResults(null); setError(''); setNotice(''); setLoadingResults(false);
    setForm(filter ? { name: filter.name, instructions: filter.instructions, mailboxId: filter.mailbox_id, folder: filter.folder, threshold: filter.threshold }
      : { ...initial, mailboxId: form.mailboxId || bootstrap?.mailboxes.find(b => b.status === 'active')?.id || '' });
    if (filter) void loadResults(filter).catch(e => setError(e.message));
  }
  async function save(andRun: boolean) {
    setBusy(true); setError(''); setNotice(''); stop.current = false;
    try {
      let filter = selected;
      const changed = !filter || form.name.trim() !== filter.name || form.instructions.trim() !== filter.instructions || form.folder !== filter.folder || form.threshold !== filter.threshold;
      if (changed) {
        const response = await api<{ filter: Filter }>(filter ? `/ai/filters/${filter.id}` : '/ai/filters', {
          method: filter ? 'PATCH' : 'POST', body: JSON.stringify({ ...form, ...(filter ? { version: filter.version } : {}) }),
        });
        filter = response.filter;
        if (!mounted.current) return;
        setSelected(filter); setFilters(old => old.some(f => f.id === filter!.id) ? old.map(f => f.id === filter!.id ? filter! : f) : [...old, filter!]);
        setResults(null);
      }
      if (!filter || !mounted.current) return;
      if (andRun) {
        setRunning(true);
        do {
          const batch = await api<{ stats: Stats }>(`/ai/filters/${filter.id}/run`, { method: 'POST', body: JSON.stringify({ version: filter.version }) });
          if (!mounted.current) return;
          await loadResults(filter);
          if (!batch.stats.pending) { setNotice('Scan complete. Run again when new mail arrives.'); break; }
          if (stop.current) { setNotice('Scan stopped. Run again to check the remaining messages.'); break; }
        } while (mounted.current);
      } else {
        await loadResults(filter);
        setNotice('Filter saved. Run it to check your emails.');
      }
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) { setBusy(false); setRunning(false); } }
  }
  async function refreshFilters() {
    setBusy(true); setError('');
    try {
      const saved = await api<{ filters: Filter[] }>('/ai/filters');
      setFilters(saved.filters); choose(saved.filters.find(f => f.id === selected?.id) || null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!selected) return;
    setBusy(true); setError('');
    try {
      await api(`/ai/filters/${selected.id}`, { method: 'DELETE' });
      setFilters(old => old.filter(f => f.id !== selected.id)); choose(null); setDeleting(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const available = bootstrap?.mailboxes.filter(b => b.status === 'active') || [];
  const valid = !!form.mailboxId && !!form.name.trim() && form.instructions.trim().length >= 3;
  return <TooltipProvider><div className="ai-workspace">
    <header className="ai-header">
      <a href="/#inbox" className="ai-back"><ArrowLeft size={16} />Mailbox</a>
      <span className="ai-wordmark"><Sparkles size={17} />Mail HQ <span>/ AI filters</span></span>
      <span className="ai-powered">Cloudflare Clef</span>
    </header>
    <div className="ai-layout">
      <aside className="ai-sidebar" aria-label="Saved AI filters">
        <div className="ai-sidebar-title"><strong>Your filters</strong><Button variant="ghost" size="icon-sm" aria-label="Refresh saved filters" disabled={busy || loading} onClick={() => void refreshFilters()}><RefreshCw size={14} /></Button></div>
        <Button variant="outline" className="ai-new" disabled={busy || loading} onClick={() => choose(null)}><Plus size={16} />New filter</Button>
        <nav className="ai-filter-list">
          {filters.map(filter => <button key={filter.id} type="button" className={selected?.id === filter.id ? 'is-active' : ''} aria-current={selected?.id === filter.id ? 'page' : undefined} disabled={busy} onClick={() => choose(filter)}>
            <Sparkles size={15} /><span><strong>{filter.name}</strong><small>{bootstrap?.mailboxes.find(b => b.id === filter.mailbox_id)?.address}</small></span>
          </button>)}
          {!filters.length && !loading && <p>Save a filter to return to it anytime.</p>}
        </nav>
        <div className="ai-agent-note"><Bot size={20} /><strong>Agent access</strong><p>MCP agents with ADMIN can create and edit these filters. Add READ to let them run a scan.</p><a href="/#agents">Manage agent connections <ArrowRight size={12} /></a></div>
      </aside>
      <main className="ai-main">
        <div className="ai-intro"><h1>{selected ? selected.name : 'AI filters'}</h1><p>Find emails by meaning. Describe what should match, choose a mailbox, and run a scan.</p></div>
        <ErrorNote message={error} />
        {loading ? <div role="status"><Spinner /> Loading filters…</div> : !available.length ? <div className="ai-empty"><Inbox /><h2>Create a mailbox first</h2><p>AI filters work with your active mailboxes.</p><a href="/#mailboxes">Go to Mailboxes</a></div> : <>
          <form className="ai-editor" onSubmit={e => { e.preventDefault(); void save(true); }}>
            <fieldset disabled={busy}>
              <div className="ai-form-heading"><h2>{selected ? 'Filter instructions' : 'Create a filter'}</h2>{selected && <Button type="button" variant="ghost" size="sm" onClick={() => setDeleting(true)}><Trash2 size={14} />Delete</Button>}</div>
              {!selected && <div className="ai-examples" aria-label="Example filters">{examples.map(example => <button type="button" key={example.name} onClick={() => setForm(value => ({ ...value, ...example }))}>{example.name}<Plus size={12} /></button>)}</div>}
              <div className="ai-field-row">
                <label>Filter name<Input required maxLength={80} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Interview requests" /></label>
                <label>Mailbox<select value={form.mailboxId} disabled={!!selected} onChange={e => setForm({ ...form, mailboxId: e.target.value })}>{available.map(box => <option key={box.id} value={box.id}>{box.address}</option>)}</select></label>
              </div>
              <label>What should match?<textarea required minLength={3} maxLength={2000} rows={4} value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })} placeholder="Only actual interview invitations or scheduling requests. Exclude advice, job listings, and newsletters." /></label>
              <div className="ai-field-row ai-options">
                <label>Search in<select value={form.folder} onChange={e => setForm({ ...form, folder: e.target.value })}><option value="inbox">Inbox</option><option value="all">All mail except spam and trash</option><option value="archive">Archive</option><option value="sent">Sent</option></select></label>
                <label>Match threshold · {Math.round(form.threshold * 100)}%<input type="range" min="50" max="99" value={Math.round(form.threshold * 100)} onChange={e => setForm({ ...form, threshold: Number(e.target.value) / 100 })} /><small>Higher values keep only stronger matches.</small></label>
              </div>
              <div className="ai-actions"><span>Saved as a view. Your emails stay where they are.</span><Button type="button" variant="outline" disabled={!valid} onClick={() => void save(false)}>Save</Button><Button type="submit" disabled={!valid}><Sparkles size={15} />{selected ? 'Save & run' : 'Create & run'}</Button></div>
            </fieldset>
          </form>
          <section className="ai-results" aria-label="Matching emails">
            <div className="ai-results-heading"><h2>Matching emails {results && <span>{results.stats.matched}</span>}</h2>{running && <Button variant="outline" size="sm" onClick={() => { stop.current = true; setNotice('Stopping after the current batch…'); }}><Square size={12} />Stop scan</Button>}</div>
            <div role="status" aria-live="polite" className="ai-scan-status">
              {running && <Spinner />}{results ? `${results.stats.checked} of ${results.stats.total} emails checked${results.stats.pending ? ` · ${results.stats.pending} remaining` : ''}` : running ? 'Checking the first batch…' : selected ? 'Run this filter to check for matches.' : 'Create a filter to start finding matches.'}
              {notice && <p>{notice}</p>}
            </div>
            {results && <progress aria-label="Emails checked" value={results.stats.checked} max={results.stats.total || 1} />}
            {results?.messages.map(message => <button className="ai-message" key={message.id} type="button" onClick={() => setPreviewId(message.id)}>
              <span className={`ai-read-dot ${message.is_read ? '' : 'is-unread'}`} /><span className="ai-message-copy"><span><strong>{message.sender_name || message.sender}</strong><time>{dateLabel(message.created_at)}</time></span><b>{message.subject || '(No subject)'}</b><small>{message.snippet}</small></span><span className="ai-score" title="Clef match probability">{Math.round(message.probability * 100)}%</span>
            </button>)}
            {results && !results.messages.length && !loadingResults && <div className="ai-empty"><Inbox size={26} /><h3>{results.stats.pending ? 'No matches among checked emails yet' : 'No matching emails'}</h3><p>{results.stats.pending ? 'Run the filter to check the remaining emails.' : 'Try adjusting your instructions or lowering the match threshold.'}</p></div>}
            {loadingResults && <div role="status" className="ai-loading"><Spinner />Loading matches…</div>}
            {results?.nextOffset != null && <Button variant="outline" disabled={busy || loadingResults} onClick={() => void loadResults(selected!, results.nextOffset!).catch(e => setError(e.message))}>Load more matches</Button>}
          </section>
          <p className="ai-footnote">AI matches can be imperfect. Each scan checks up to 24,000 characters per email; attachment contents are excluded.{!!results?.stats.truncated && ` ${results.stats.truncated} checked email(s) exceeded that limit.`} Scans use your Cloudflare Workers AI allowance.</p>
        </>}
      </main>
    </div>
    {previewId && <Modal title={preview?.subject || 'Email preview'} subtitle={preview ? `${preview.sender_name || preview.sender} · ${preview.sender}` : 'Loading message…'} onClose={() => setPreviewId('')} wide>
      <div className="ai-preview"><ErrorNote message={previewError} />{preview ? <EmailPreview message={preview} /> : !previewError && <Spinner />}<p className="ai-footnote">Previewing here keeps this email’s read status unchanged.</p></div>
    </Modal>}
    {deleting && <Modal title="Delete this filter?" subtitle="This removes the saved filter and its matches. All emails stay in your mailbox." onClose={() => { if (!busy) setDeleting(false); }}>
      <div className="ai-preview"><ErrorNote message={error} /><div className="ai-actions"><Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>Keep filter</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>Delete filter</Button></div></div>
    </Modal>}
  </div></TooltipProvider>;
}
