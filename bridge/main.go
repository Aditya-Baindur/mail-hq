// Mail HQ's TLS protocol gateway. D1/R2 remain the durable source of truth.
package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/backend"
	"github.com/emersion/go-imap/backend/backendutil"
	"github.com/emersion/go-imap/commands"
	"github.com/emersion/go-imap/responses"
	"github.com/emersion/go-imap/server"
	"github.com/emersion/go-message"
	"github.com/emersion/go-message/textproto"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

var apiURL, apiSecret string
var httpClient = &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
var knownFolders = []string{"INBOX", "Sent", "Drafts", "Archive", "Junk", "Trash"}
var permanentFlags = []string{imap.SeenFlag, imap.FlaggedFlag, imap.AnsweredFlag, imap.DeletedFlag, imap.DraftFlag}

func folderKey(name string) string {
	if name == "Junk" {
		return "spam"
	}
	return strings.ToLower(name)
}
func canonical(name string) string {
	if strings.EqualFold(name, "inbox") {
		return "INBOX"
	}
	return name
}

type apiError struct {
	Status  int
	Message string
}

func (e *apiError) Error() string { return e.Message }

type user struct{ address, password string }

func (u *user) call(op any, output any) error {
	data, err := json.Marshal(op)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", apiURL, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.SetBasicAuth(u.address, u.password)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-MailHQ-Bridge", apiSecret)
	resp, err := httpClient.Do(req)
	if err != nil {
		return errors.New("Mail HQ is temporarily unavailable")
	}
	defer resp.Body.Close()
	reader := io.LimitReader(resp.Body, 36*1024*1024)
	if resp.StatusCode != 200 {
		var v struct{ Error string }
		_ = json.NewDecoder(reader).Decode(&v)
		if v.Error == "" {
			v.Error = "Mail HQ request failed"
		}
		return &apiError{resp.StatusCode, v.Error}
	}
	if output == nil {
		_, err = io.Copy(io.Discard, reader)
		return err
	}
	return json.NewDecoder(reader).Decode(output)
}
func (u *user) authenticate() error { return u.call(map[string]any{"action": "login"}, nil) }

// Bound failed logins and simultaneous TLS connections before calling the Worker.
type ipState struct {
	active, attempts int
	window           time.Time
}

var limits = struct {
	sync.Mutex
	ips   map[string]*ipState
	total int
}{ips: map[string]*ipState{}}

func ipOf(addr net.Addr) string { ip, _, _ := net.SplitHostPort(addr.String()); return ip }
func loginAllowed(ip string) bool {
	limits.Lock()
	defer limits.Unlock()
	s := limits.ips[ip]
	if s == nil {
		s = &ipState{}
		limits.ips[ip] = s
	}
	if time.Since(s.window) > time.Minute {
		s.window = time.Now()
		s.attempts = 0
	}
	s.attempts++
	return s.attempts <= 20
}

type boundListener struct{ net.Listener }
type boundConn struct {
	net.Conn
	ip   string
	once sync.Once
}

func (c *boundConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { limits.Lock(); defer limits.Unlock(); limits.total--; limits.ips[c.ip].active-- })
	return err
}
func (l *boundListener) Accept() (net.Conn, error) {
	for {
		c, e := l.Listener.Accept()
		if e != nil {
			return nil, e
		}
		ip := ipOf(c.RemoteAddr())
		limits.Lock()
		for k, s := range limits.ips {
			if s.active == 0 && time.Since(s.window) > time.Hour {
				delete(limits.ips, k)
			}
		}
		s := limits.ips[ip]
		if s == nil {
			s = &ipState{window: time.Now()}
			limits.ips[ip] = s
		}
		ok := limits.total < 128 && s.active < 16
		if ok {
			limits.total++
			s.active++
		}
		limits.Unlock()
		if !ok {
			c.Close()
			continue
		}
		_ = c.SetDeadline(time.Now().Add(30 * time.Second))
		return &boundConn{Conn: c, ip: ip}, nil
	}
}

type imapBackend struct{}

func (*imapBackend) Login(info *imap.ConnInfo, username, password string) (backend.User, error) {
	if !loginAllowed(ipOf(info.RemoteAddr)) {
		return nil, backend.ErrInvalidCredentials
	}
	u := &user{strings.ToLower(strings.TrimSpace(username)), password}
	if e := u.authenticate(); e != nil {
		return nil, backend.ErrInvalidCredentials
	}
	return u, nil
}
func (u *user) Username() string { return u.address }
func (u *user) Logout() error    { return nil }
func (u *user) ListMailboxes(_ bool) ([]backend.Mailbox, error) {
	if e := u.authenticate(); e != nil {
		return nil, e
	}
	var out []backend.Mailbox
	for _, n := range knownFolders {
		out = append(out, &mailbox{user: u, name: n})
	}
	return out, nil
}
func (u *user) GetMailbox(name string) (backend.Mailbox, error) {
	name = canonical(name)
	if !slices.Contains(knownFolders, name) {
		return nil, backend.ErrNoSuchMailbox
	}
	return &mailbox{user: u, name: name}, nil
}
func (u *user) CreateMailbox(name string) error {
	if slices.Contains(knownFolders, canonical(name)) {
		return backend.ErrMailboxAlreadyExists
	}
	return errors.New("Use Mail HQ's existing folders")
}
func (u *user) DeleteMailbox(string) error { return errors.New("System folders cannot be deleted") }
func (u *user) RenameMailbox(string, string) error {
	return errors.New("System folders cannot be renamed")
}

type metadata struct {
	UID   uint32    `json:"uid"`
	Date  time.Time `json:"date"`
	Flags []string  `json:"flags"`
}
type snapshot struct {
	UIDValidity uint32     `json:"uidValidity"`
	UIDNext     uint32     `json:"uidNext"`
	Messages    []metadata `json:"messages"`
}
type mailbox struct {
	readonly bool
	user     *user
	name     string
	state    *snapshot
	rawUID   uint32
	rawCache []byte
}

func (m *mailbox) Name() string { return m.name }
func (m *mailbox) Info() (*imap.MailboxInfo, error) {
	attrs := []string{imap.NoInferiorsAttr}
	if m.name != "INBOX" {
		attrs = append(attrs, "\\"+m.name)
	}
	return &imap.MailboxInfo{Name: m.name, Delimiter: "/", Attributes: attrs}, nil
}
func (m *mailbox) load() (*snapshot, error) {
	var s snapshot
	e := m.user.call(map[string]any{"action": "snapshot", "folder": folderKey(m.name)}, &s)
	return &s, e
}
func (m *mailbox) Status(items []imap.StatusItem) (*imap.MailboxStatus, error) {
	s, e := m.load()
	if e != nil {
		return nil, e
	}
	m.state = s
	status := imap.NewMailboxStatus(m.name, items)
	status.Flags = permanentFlags
	status.PermanentFlags = permanentFlags
	status.UidValidity = s.UIDValidity
	status.UidNext = s.UIDNext
	status.Messages = uint32(len(s.Messages))
	for i, v := range s.Messages {
		if !slices.Contains(v.Flags, imap.SeenFlag) {
			status.Unseen++
			if status.UnseenSeqNum == 0 {
				status.UnseenSeqNum = uint32(i + 1)
			}
		}
	}
	return status, nil
}
func (m *mailbox) SetSubscribed(bool) error { return m.user.authenticate() }
func (m *mailbox) Check() error             { return m.user.authenticate() }
func (m *mailbox) ensure() error {
	if m.state == nil {
		s, e := m.load()
		if e != nil {
			return e
		}
		m.state = s
	}
	return m.user.authenticate()
}
func resolveSet(set *imap.SeqSet, max uint32) *imap.SeqSet {
	out := &imap.SeqSet{}
	for _, s := range set.Set {
		a, b := s.Start, s.Stop
		if a == 0 {
			a = max
		}
		if b == 0 {
			b = max
		}
		if a != 0 && b != 0 {
			out.AddRange(a, b)
		}
	}
	return out
}
func (m *mailbox) selected(uid bool, set *imap.SeqSet) []int {
	var out []int
	if len(m.state.Messages) == 0 {
		return out
	}
	max := uint32(len(m.state.Messages))
	if uid {
		max = m.state.Messages[len(m.state.Messages)-1].UID
	}
	set = resolveSet(set, max)
	for i, v := range m.state.Messages {
		n := uint32(i + 1)
		if uid {
			n = v.UID
		}
		if set.Contains(n) {
			out = append(out, i)
		}
	}
	return out
}
func (m *mailbox) raw(id uint32) ([]byte, error) {
	if m.rawUID == id {
		return m.rawCache, nil
	}
	var v struct{ Raw string }
	if e := m.user.call(map[string]any{"action": "raw", "uid": id}, &v); e != nil {
		return nil, e
	}
	b, e := base64.StdEncoding.DecodeString(v.Raw)
	if e == nil {
		m.rawUID = id
		m.rawCache = b
	}
	return b, e
}
func (m *mailbox) refreshFlags() error {
	s, e := m.load()
	if e != nil {
		return e
	}
	byUID := map[uint32]metadata{}
	for _, v := range s.Messages {
		byUID[v.UID] = v
	}
	for i, v := range m.state.Messages {
		if n, ok := byUID[v.UID]; ok {
			m.state.Messages[i] = n
		}
	}
	return nil
}
func fetchMessage(meta metadata, seq uint32, raw []byte, items []imap.FetchItem) (*imap.Message, error) {
	fetched := imap.NewMessage(seq, items)
	for _, item := range items {
		switch item {
		case imap.FetchFlags:
			fetched.Flags = meta.Flags
		case imap.FetchInternalDate:
			fetched.InternalDate = meta.Date
		case imap.FetchRFC822Size:
			fetched.Size = uint32(len(raw))
		case imap.FetchUid:
			fetched.Uid = meta.UID
		default:
			body := bufio.NewReader(bytes.NewReader(raw))
			hdr, e := textproto.ReadHeader(body)
			if e != nil {
				return nil, e
			}
			switch item {
			case imap.FetchEnvelope:
				fetched.Envelope, e = backendutil.FetchEnvelope(hdr)
			case imap.FetchBody, imap.FetchBodyStructure:
				fetched.BodyStructure, e = backendutil.FetchBodyStructure(hdr, body, item == imap.FetchBodyStructure)
			default:
				section, err := imap.ParseBodySectionName(item)
				if err != nil {
					return nil, err
				}
				fetched.Body[section], e = backendutil.FetchBodySection(hdr, body, section)
			}
			if e != nil {
				return nil, e
			}
		}
	}
	return fetched, nil
}
func (m *mailbox) ListMessages(uid bool, set *imap.SeqSet, items []imap.FetchItem, ch chan<- *imap.Message) error {
	defer close(ch)
	if e := m.ensure(); e != nil {
		return e
	}
	if e := m.refreshFlags(); e != nil {
		return e
	}
	for _, i := range m.selected(uid, set) {
		meta := m.state.Messages[i]
		needsRaw := false
		seen := false
		for _, item := range items {
			if item != imap.FetchUid && item != imap.FetchFlags && item != imap.FetchInternalDate {
				needsRaw = true
			}
			if section, e := imap.ParseBodySectionName(item); e == nil && !section.Peek {
				seen = true
			}
		}
		var raw []byte
		var e error
		if needsRaw {
			raw, e = m.raw(meta.UID)
			if e != nil {
				var ae *apiError
				if errors.As(e, &ae) && ae.Status == 404 {
					continue
				}
				return e
			}
		}
		// The library rejects STORE on EXAMINE; BODY fetches are guarded by the wrapper below.
		if seen && !slices.Contains(meta.Flags, imap.SeenFlag) && !m.readOnly() {
			if e = m.flags([]uint32{meta.UID}, "add", []string{imap.SeenFlag}); e != nil {
				return e
			}
			meta.Flags = append(meta.Flags, imap.SeenFlag)
			m.state.Messages[i] = meta
			items = appendUnique(items, imap.FetchFlags)
		}
		msg, e := fetchMessage(meta, uint32(i+1), raw, items)
		if e != nil {
			return e
		}
		ch <- msg
	}
	return nil
}
func appendUnique(items []imap.FetchItem, item imap.FetchItem) []imap.FetchItem {
	if slices.Contains(items, item) {
		return items
	}
	return append(append([]imap.FetchItem{}, items...), item)
}

func (m *mailbox) readOnly() bool { return m.readonly }

// go-imap v1 compares SINCE strictly; IMAP includes the specified calendar day.
// Normalize nested criteria too, including sequence-set '*' in NOT/OR clauses.
func searchCriteria(c *imap.SearchCriteria, count, lastUID uint32) (*imap.SearchCriteria, bool) {
	criteria := *c
	if !criteria.Since.IsZero() {
		criteria.Since = criteria.Since.Add(-time.Nanosecond)
	}
	if criteria.SeqNum != nil {
		criteria.SeqNum = resolveSet(criteria.SeqNum, count)
	}
	if criteria.Uid != nil {
		criteria.Uid = resolveSet(criteria.Uid, lastUID)
	}
	needsRaw := len(c.Header)+len(c.Body)+len(c.Text) > 0 || c.Larger > 0 || c.Smaller > 0 || !c.SentSince.IsZero() || !c.SentBefore.IsZero()
	criteria.Not = make([]*imap.SearchCriteria, len(c.Not))
	for i, nested := range c.Not {
		var raw bool
		criteria.Not[i], raw = searchCriteria(nested, count, lastUID)
		needsRaw = needsRaw || raw
	}
	criteria.Or = make([][2]*imap.SearchCriteria, len(c.Or))
	for i, pair := range c.Or {
		for j, nested := range pair {
			var raw bool
			criteria.Or[i][j], raw = searchCriteria(nested, count, lastUID)
			needsRaw = needsRaw || raw
		}
	}
	return &criteria, needsRaw
}

func (m *mailbox) SearchMessages(uid bool, c *imap.SearchCriteria) ([]uint32, error) {
	if e := m.ensure(); e != nil {
		return nil, e
	}
	if e := m.refreshFlags(); e != nil {
		return nil, e
	}
	out := []uint32{}
	var lastUID uint32
	if len(m.state.Messages) > 0 {
		lastUID = m.state.Messages[len(m.state.Messages)-1].UID
	}
	criteria, needsRaw := searchCriteria(c, uint32(len(m.state.Messages)), lastUID)
	for i, v := range m.state.Messages {
		entity := &message.Entity{}
		if needsRaw {
			raw, e := m.raw(v.UID)
			if e != nil {
				return nil, e
			}
			entity, e = message.Read(bytes.NewReader(raw))
			if e != nil && !message.IsUnknownCharset(e) {
				return nil, e
			}
			if entity == nil {
				return nil, errors.New("Invalid MIME")
			}
		}
		ok, e := backendutil.Match(entity, uint32(i+1), v.UID, v.Date, v.Flags, criteria)
		if e != nil {
			return nil, e
		}
		if ok {
			n := uint32(i + 1)
			if uid {
				n = v.UID
			}
			out = append(out, n)
		}
	}
	return out, nil
}
func (m *mailbox) CreateMessage(flags []string, date time.Time, body imap.Literal) error {
	b, e := io.ReadAll(io.LimitReader(body, 25*1024*1024+1))
	if e != nil {
		return e
	}
	if len(b) > 25*1024*1024 {
		return errors.New("Message exceeds 25 MiB")
	}
	if date.IsZero() {
		date = time.Now()
	}
	return m.user.call(map[string]any{"action": "append", "folder": folderKey(m.name), "flags": filterFlags(flags), "date": date.UTC().Format(time.RFC3339Nano), "raw": base64.StdEncoding.EncodeToString(b)}, nil)
}
func filterFlags(flags []string) []string {
	out := []string{}
	for _, f := range flags {
		if slices.Contains(permanentFlags, f) && !slices.Contains(out, f) {
			out = append(out, f)
		}
	}
	return out
}
func (m *mailbox) flags(ids []uint32, op string, flags []string) error {
	for len(ids) > 0 {
		n := min(len(ids), 200)
		if e := m.user.call(map[string]any{"action": "flags", "uids": ids[:n], "operation": op, "flags": filterFlags(flags)}, nil); e != nil {
			return e
		}
		ids = ids[n:]
	}
	return nil
}
func (m *mailbox) UpdateMessagesFlags(uid bool, set *imap.SeqSet, op imap.FlagsOp, flags []string) error {
	if e := m.ensure(); e != nil {
		return e
	}
	ids := []uint32{}
	for _, i := range m.selected(uid, set) {
		ids = append(ids, m.state.Messages[i].UID)
	}
	operation := "set"
	if op == imap.AddFlags {
		operation = "add"
	}
	if op == imap.RemoveFlags {
		operation = "remove"
	}
	if e := m.flags(ids, operation, flags); e != nil {
		return e
	}
	return m.refreshFlags()
}
func (m *mailbox) transfer(uid bool, set *imap.SeqSet, dest string, move bool) error {
	dest = canonical(dest)
	if !slices.Contains(knownFolders, dest) {
		return backend.ErrNoSuchMailbox
	}
	if e := m.ensure(); e != nil {
		return e
	}
	ids := []uint32{}
	for _, i := range m.selected(uid, set) {
		ids = append(ids, m.state.Messages[i].UID)
	}
	for len(ids) > 0 {
		n := min(50, len(ids))
		if e := m.user.call(map[string]any{"action": "transfer", "uids": ids[:n], "folder": folderKey(dest), "move": move}, nil); e != nil {
			return e
		}
		ids = ids[n:]
	}
	return nil
}
func (m *mailbox) CopyMessages(uid bool, set *imap.SeqSet, dest string) error {
	return m.transfer(uid, set, dest, false)
}
func (m *mailbox) Expunge() error {
	if e := m.ensure(); e != nil {
		return e
	}
	if e := m.refreshFlags(); e != nil {
		return e
	}
	ids := []uint32{}
	for _, v := range m.state.Messages {
		if slices.Contains(v.Flags, imap.DeletedFlag) {
			ids = append(ids, v.UID)
		}
	}
	for len(ids) > 0 {
		n := min(200, len(ids))
		if e := m.user.call(map[string]any{"action": "expunge", "uids": ids[:n]}, nil); e != nil {
			return e
		}
		ids = ids[n:]
	}
	return nil
}

// Publish changes only at safe IMAP boundaries. Each connection retains its own
// UID/sequence mapping until it has actually received the corresponding EXPUNGE.
func poll(c server.Conn) error {
	m, ok := c.Context().Mailbox.(*mailbox)
	if !ok {
		if u, ok := c.Context().User.(*user); ok {
			return u.authenticate()
		}
		return nil
	}
	next, e := m.load()
	if e != nil {
		return e
	}
	if m.state == nil {
		m.state = next
		return nil
	}
	previousCount := len(m.state.Messages)
	present := map[uint32]metadata{}
	for _, v := range next.Messages {
		present[v.UID] = v
	}
	for i := len(m.state.Messages) - 1; i >= 0; i-- {
		if _, ok := present[m.state.Messages[i].UID]; !ok {
			if e := c.WriteResp(imap.NewUntaggedResp([]interface{}{uint32(i + 1), imap.RawString("EXPUNGE")})); e != nil {
				return e
			}
			m.state.Messages = append(m.state.Messages[:i], m.state.Messages[i+1:]...)
		}
	}
	old := map[uint32]metadata{}
	for _, v := range m.state.Messages {
		old[v.UID] = v
	}
	if len(next.Messages) != len(m.state.Messages) || len(next.Messages) != previousCount {
		if e := c.WriteResp(imap.NewUntaggedResp([]interface{}{uint32(len(next.Messages)), imap.RawString("EXISTS")})); e != nil {
			return e
		}
	}
	for i, v := range next.Messages {
		if p, ok := old[v.UID]; ok && !slices.Equal(p.Flags, v.Flags) {
			msg := imap.NewMessage(uint32(i+1), []imap.FetchItem{imap.FetchUid, imap.FetchFlags})
			msg.Uid = v.UID
			msg.Flags = v.Flags
			ch := make(chan *imap.Message, 1)
			ch <- msg
			close(ch)
			if e := c.WriteResp(&responses.Fetch{Messages: ch}); e != nil {
				return e
			}
		}
	}
	m.state = next
	return nil
}

// go-imap v1's Enable filters obsolete standalone MOVE/IDLE extensions by
// probing their commands. Register the combined command adapter before activating
// its built-in overrides; Server.Command explicitly supports these overrides.
type extension struct{ active bool }

func enableBridgeCommands(s *server.Server) { ext := &extension{}; s.Enable(ext); ext.active = true }

func (*extension) Capabilities(c server.Conn) []string {
	if c.Context().State&imap.AuthenticatedState != 0 {
		return []string{"SPECIAL-USE"}
	}
	return nil
}
func (ext *extension) Command(name string) server.HandlerFactory {
	if !ext.active {
		return nil
	}
	switch name {
	case "IDLE", "NOOP", "CHECK", "EXPUNGE", "CLOSE", "UNSELECT":
		return func() server.Handler { return &simpleHandler{name: name} }
	case "MOVE":
		return func() server.Handler { return &moveHandler{} }
	case "APPEND":
		return func() server.Handler { return &appendHandler{} }
	case "COPY":
		return func() server.Handler { return &copyHandler{} }
	case "SELECT":
		return func() server.Handler { return &selectHandler{} }
	case "EXAMINE":
		return func() server.Handler { return &selectHandler{readonly: true} }
	}
	return nil
}

type selectHandler struct {
	commands.Select
	readonly bool
}

func (h *selectHandler) Handle(c server.Conn) error {
	cmd := &server.Select{}
	cmd.Mailbox = h.Mailbox
	cmd.ReadOnly = h.readonly
	err := cmd.Handle(c)
	if m, ok := c.Context().Mailbox.(*mailbox); ok {
		m.readonly = h.readonly
	}
	return err
}

type simpleHandler struct{ name string }

// Read only DONE: a buffered reader here could swallow the next pipelined command.
func readIdleDone(r io.Reader) error {
	var line [6]byte
	for i := range line {
		if _, e := io.ReadFull(r, line[i:i+1]); e != nil {
			return e
		}
		if line[i] == '\n' {
			if strings.EqualFold(strings.TrimSpace(string(line[:i+1])), "DONE") {
				return nil
			}
			break
		}
	}
	return errors.New("Expected DONE")
}

func (h *simpleHandler) Parse(fields []interface{}) error {
	if len(fields) != 0 {
		return errors.New("Unexpected arguments")
	}
	return nil
}
func (h *simpleHandler) Handle(c server.Conn) error {
	if h.name == "NOOP" {
		return poll(c)
	}
	if h.name == "IDLE" {
		if c.Context().User == nil {
			return errors.New("Authenticate first")
		}
		if e := poll(c); e != nil {
			return e
		}
		if e := c.WriteResp(&imap.ContinuationReq{Info: "idling"}); e != nil {
			return e
		}
		done := make(chan error, 1)
		go func() {
			done <- readIdleDone(c)
		}()
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case e := <-done:
				return e
			case <-ticker.C:
				if e := poll(c); e != nil {
					_ = c.WriteResp(&imap.StatusResp{Type: imap.StatusRespBye, Info: "Mail session ended; reconnect to authenticate"})
					c.Close()
					return e
				}
			}
		}
	}
	m, ok := c.Context().Mailbox.(*mailbox)
	if !ok {
		return server.ErrNoMailboxSelected
	}
	switch h.name {
	case "CHECK":
		return poll(c)
	case "EXPUNGE":
		if c.Context().MailboxReadOnly {
			return server.ErrMailboxReadOnly
		}
		if e := m.Expunge(); e != nil {
			return e
		}
		return poll(c)
	case "CLOSE", "UNSELECT":
		if h.name == "CLOSE" && !c.Context().MailboxReadOnly {
			if e := m.Expunge(); e != nil {
				return e
			}
		}

		c.Context().Mailbox = nil
		c.Context().MailboxReadOnly = false
		c.Context().State = imap.AuthenticatedState
		return nil
	}
	return nil
}

type moveHandler struct{ commands.Move }

type appendHandler struct{ commands.Append }

func (h *appendHandler) Handle(c server.Conn) error {
	if c.Context().User == nil {
		return server.ErrNotAuthenticated
	}
	m, err := c.Context().User.GetMailbox(h.Mailbox)
	if err != nil {
		return err
	}
	if err = m.CreateMessage(h.Flags, h.Date, h.Message); err != nil {
		return err
	}
	return poll(c)
}

type copyHandler struct{ commands.Copy }

func (h *copyHandler) Handle(c server.Conn) error    { return h.run(c, false) }
func (h *copyHandler) UidHandle(c server.Conn) error { return h.run(c, true) }
func (h *copyHandler) run(c server.Conn, uid bool) error {
	m, ok := c.Context().Mailbox.(*mailbox)
	if !ok {
		return server.ErrNoMailboxSelected
	}
	if err := m.transfer(uid, h.SeqSet, h.Mailbox, false); err != nil {
		return err
	}
	return poll(c)
}

func (h *moveHandler) Handle(c server.Conn) error    { return h.run(c, false) }
func (h *moveHandler) UidHandle(c server.Conn) error { return h.run(c, true) }
func (h *moveHandler) run(c server.Conn, uid bool) error {
	m, ok := c.Context().Mailbox.(*mailbox)
	if !ok {
		return server.ErrNoMailboxSelected
	}
	if c.Context().MailboxReadOnly {
		return server.ErrMailboxReadOnly
	}
	if e := m.transfer(uid, h.SeqSet, h.Mailbox, true); e != nil {
		return e
	}
	return poll(c)
}

type smtpSession struct {
	u          *user
	conn       *smtp.Conn
	recipients []string
}

func (s *smtpSession) Reset()                   { s.recipients = nil }
func (s *smtpSession) Logout() error            { s.u = nil; return nil }
func (s *smtpSession) AuthMechanisms() []string { return []string{sasl.Plain} }
func (s *smtpSession) Auth(mech string) (sasl.Server, error) {
	if mech != sasl.Plain {
		return nil, smtp.ErrAuthUnknownMechanism
	}
	return sasl.NewPlainServer(func(identity, username, password string) error {
		if identity != "" && identity != username {
			return smtp.ErrAuthFailed
		}
		if !loginAllowed(ipOf(s.conn.Conn().RemoteAddr())) {
			return smtp.ErrAuthFailed
		}
		u := &user{strings.ToLower(strings.TrimSpace(username)), password}
		if e := u.authenticate(); e != nil {
			return smtp.ErrAuthFailed
		}
		s.u = u
		return nil
	}), nil
}
func (s *smtpSession) Mail(from string, _ *smtp.MailOptions) error {
	if s.u == nil {
		return smtp.ErrAuthRequired
	}
	if !strings.EqualFold(from, s.u.address) {
		return &smtp.SMTPError{Code: 553, Message: "Sender must match authenticated mailbox"}
	}
	return s.u.authenticate()
}
func (s *smtpSession) Rcpt(to string, _ *smtp.RcptOptions) error {
	if s.u == nil {
		return smtp.ErrAuthRequired
	}
	s.recipients = append(s.recipients, to)
	return nil
}
func (s *smtpSession) Data(r io.Reader) error {
	if s.u == nil {
		return smtp.ErrAuthRequired
	}
	raw, e := io.ReadAll(io.LimitReader(r, 5*1024*1024+1))
	if e != nil {
		return e
	}
	if len(raw) > 5*1024*1024 {
		return &smtp.SMTPError{Code: 552, Message: "Message exceeds 5 MiB"}
	}
	e = s.u.call(map[string]any{"action": "submit", "raw": base64.StdEncoding.EncodeToString(raw), "recipients": s.recipients}, nil)
	if e != nil {
		var ae *apiError
		if errors.As(e, &ae) && ae.Status < 500 && ae.Status != 429 {
			return &smtp.SMTPError{Code: 554, Message: ae.Message}
		}
		return &smtp.SMTPError{Code: 451, Message: "Mail HQ is temporarily unavailable"}
	}
	return nil
}

func tlsListener(addr string, config *tls.Config) (net.Listener, error) {
	l, e := net.Listen("tcp", addr)
	if e != nil {
		return nil, e
	}
	return tls.NewListener(&boundListener{l}, config), nil
}
func main() {
	apiURL = os.Getenv("MAILHQ_API_URL")
	apiSecret = os.Getenv("MAILHQ_BRIDGE_SECRET")
	host := os.Getenv("MAILHQ_HOST")
	if apiURL == "" || apiSecret == "" || host == "" {
		log.Fatal("MAILHQ_API_URL, MAILHQ_BRIDGE_SECRET and MAILHQ_HOST are required")
	}
	if !strings.HasPrefix(apiURL, "https://") {
		log.Fatal("Worker API must use HTTPS")
	}
	config := &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		cert, e := tls.LoadX509KeyPair(os.Getenv("TLS_CERT"), os.Getenv("TLS_KEY"))
		return &cert, e
	}}
	if _, err := config.GetCertificate(nil); err != nil {
		log.Fatal("Cannot load bridge TLS certificate: ", err)
	}
	imaps := server.New(&imapBackend{})
	imaps.TLSConfig = config
	imaps.AllowInsecureAuth = false
	imaps.AutoLogout = 30 * time.Minute
	imaps.MaxLiteralSize = 25 * 1024 * 1024
	enableBridgeCommands(imaps)
	imapListener, e := tlsListener(":993", config)
	if e != nil {
		log.Fatal(e)
	}
	smtps := smtp.NewServer(smtp.BackendFunc(func(c *smtp.Conn) (smtp.Session, error) { return &smtpSession{conn: c}, nil }))
	smtps.Domain = host
	smtps.TLSConfig = config
	smtps.MaxMessageBytes = 5 * 1024 * 1024
	smtps.MaxRecipients = 50
	smtps.ReadTimeout = 2 * time.Minute
	smtps.WriteTimeout = 2 * time.Minute
	smtps.AllowInsecureAuth = false
	smtpListener, e := tlsListener(":465", config)
	if e != nil {
		log.Fatal(e)
	}
	go func() { log.Fatal(imaps.Serve(imapListener)) }()
	go func() { log.Fatal(smtps.Serve(smtpListener)) }()
	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintln(w, `{"service":"mail-hq-bridge","status":"ok","imap":993,"smtp":465}`)
	})
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	log.Printf("Mail HQ bridge listening on TLS 993/465")
	log.Fatal((&http.Server{Addr: ":8080", ReadHeaderTimeout: 5 * time.Second, Handler: http.DefaultServeMux}).ListenAndServe())
}
