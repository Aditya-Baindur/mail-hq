package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	stdsmtp "net/smtp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
	"github.com/emersion/go-imap/server"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

type fixtureMessage struct {
	metadata
	raw    []byte
	folder string
}

func TestIMAPProtocol(t *testing.T) {
	var mu sync.Mutex
	next := uint32(1)
	revoked := false
	rawRequests := 0
	messages := map[uint32]*fixtureMessage{}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		name, password, ok := r.BasicAuth()
		if !ok || name != "mail@example.com" || password != "test-password" || revoked {
			http.Error(w, `{"error":"Revoked"}`, 401)
			return
		}
		var op struct {
			Action    string
			Folder    string
			UID       uint32
			UIDs      []uint32
			Raw       string
			Date      time.Time
			Flags     []string
			Operation string
			Move      bool
		}
		if e := json.NewDecoder(r.Body).Decode(&op); e != nil {
			t.Error(e)
			w.WriteHeader(400)
			return
		}
		var result any = map[string]any{"ok": true}
		switch op.Action {
		case "snapshot":
			s := snapshot{UIDValidity: 1, UIDNext: next, Messages: []metadata{}}
			for id := uint32(1); id < next; id++ {
				if m := messages[id]; m != nil && m.folder == op.Folder {
					s.Messages = append(s.Messages, m.metadata)
				}
			}
			result = s
		case "raw":
			rawRequests++
			if m := messages[op.UID]; m != nil {
				result = map[string]string{"raw": base64.StdEncoding.EncodeToString(m.raw)}
			} else {
				http.Error(w, `{"error":"Missing"}`, 404)
				return
			}
		case "append":
			raw, _ := base64.StdEncoding.DecodeString(op.Raw)
			messages[next] = &fixtureMessage{metadata: metadata{UID: next, Flags: op.Flags, Date: op.Date}, raw: raw, folder: op.Folder}
			next++
		case "flags":
			for _, id := range op.UIDs {
				m := messages[id]
				if op.Operation == "set" {
					m.Flags = op.Flags
				} else {
					for _, f := range op.Flags {
						if op.Operation == "add" && !slices.Contains(m.Flags, f) {
							m.Flags = append(m.Flags, f)
						}
						if op.Operation == "remove" {
							m.Flags = slices.DeleteFunc(m.Flags, func(v string) bool { return v == f })
						}
					}
				}
			}
		case "transfer":
			for _, id := range op.UIDs {
				m := *messages[id]
				m.UID = next
				m.folder = op.Folder
				messages[next] = &m
				next++
				if op.Move {
					delete(messages, id)
				}
			}
		case "expunge":
			for _, id := range op.UIDs {
				delete(messages, id)
			}
		}
		_ = json.NewEncoder(w).Encode(result)
	}))
	defer worker.Close()
	apiURL = worker.URL
	apiSecret = "test-bridge"
	certServer := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer certServer.Close()
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	s := server.New(&imapBackend{})
	s.TLSConfig = certServer.TLS
	s.MaxLiteralSize = 25 * 1024 * 1024
	enableBridgeCommands(s)
	go s.Serve(tls.NewListener(listener, certServer.TLS))
	defer s.Close()
	connect := func() *client.Client {
		c, e := client.DialTLS(listener.Addr().String(), &tls.Config{InsecureSkipVerify: true})
		if e != nil {
			t.Fatal(e)
		}
		c.Timeout = 5 * time.Second
		if e = c.Login("mail@example.com", "test-password"); e != nil {
			t.Fatal(e)
		}
		return c
	}
	c := connect()
	defer c.Terminate()
	raw := []byte("From: sender@example.net\r\nTo: mail@example.com\r\nSubject: Test MIME\r\nDate: Wed, 7 Oct 2026 12:00:00 +0000\r\nMessage-ID: <fixture@example.net>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello world!\r\n")
	if e = c.Append("INBOX", nil, time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC), bytes.NewReader(raw)); e != nil {
		t.Fatal(e)
	}
	status, e := c.Select("INBOX", false)
	if e != nil {
		t.Fatal(e)
	}
	if status.Messages != 1 || status.UidValidity != 1 {
		t.Fatalf("unexpected SELECT: %+v", status)
	}
	fetch := func(c *client.Client, item imap.FetchItem) *imap.Message {
		ch := make(chan *imap.Message, 10)
		done := make(chan error, 1)
		go func() {
			done <- c.UidFetch(&imap.SeqSet{Set: []imap.Seq{{Start: 1, Stop: 1}}}, []imap.FetchItem{imap.FetchUid, imap.FetchFlags, imap.FetchRFC822Size, imap.FetchEnvelope, imap.FetchBodyStructure, item}, ch)
		}()
		var result *imap.Message
		for m := range ch {
			result = m
		}
		if e := <-done; e != nil {
			t.Fatal(e)
		}
		if result == nil {
			t.Fatal("no FETCH response")
		}
		return result
	}
	msg := fetch(c, "BODY.PEEK[]<5.19>")
	if msg.Size != uint32(len(raw)) || msg.Envelope.Subject != "Test MIME" {
		t.Fatalf("invalid MIME metadata: %+v", msg)
	}
	for _, body := range msg.Body {
		got, _ := io.ReadAll(body)
		if !bytes.Equal(got, raw[5:24]) {
			t.Fatalf("partial body: %q", got)
		}
	}
	if slices.Contains(msg.Flags, imap.SeenFlag) {
		t.Fatal("PEEK marked read")
	}
	c2 := connect()
	defer c2.Terminate()
	if _, e = c2.Select("INBOX", true); e != nil {
		t.Fatal(e)
	}
	readonly := fetch(c2, "BODY[]")
	if slices.Contains(readonly.Flags, imap.SeenFlag) {
		t.Fatal("EXAMINE changed Seen")
	}
	if e = c2.Close(); e != nil {
		t.Fatal(e)
	}
	full := fetch(c, "BODY[]")
	if !slices.Contains(full.Flags, imap.SeenFlag) {
		t.Fatal("BODY did not mark Seen")
	}
	for _, body := range full.Body {
		got, _ := io.ReadAll(body)
		if !bytes.Equal(got, raw) {
			t.Fatal("raw MIME changed")
		}
	}
	if e = c.UidStore(&imap.SeqSet{Set: []imap.Seq{{Start: 1, Stop: 1}}}, imap.AddFlags, []interface{}{imap.FlaggedFlag}, nil); e != nil {
		t.Fatal(e)
	}
	if _, e = c2.Select("INBOX", false); e != nil {
		t.Fatal(e)
	}
	if !slices.Contains(fetch(c2, "BODY.PEEK[HEADER]").Flags, imap.FlaggedFlag) {
		t.Fatal("flags did not sync")
	}
	if e = c.UidMove(&imap.SeqSet{Set: []imap.Seq{{Start: 1, Stop: 1}}}, "Archive"); e != nil {
		t.Fatal(e)
	}
	if e = c2.Noop(); e != nil {
		t.Fatal(e)
	}
	if c2.Mailbox().Messages != 0 {
		t.Fatal("other connection missed expunge")
	}
	status, e = c.Select("Archive", false)
	if e != nil {
		t.Fatal(e)
	}
	if status.Messages != 1 || status.UidNext <= 2 {
		t.Fatalf("bad moved state: %+v", status)
	}
	ids, e := c.UidSearch(imap.NewSearchCriteria())
	if e != nil || len(ids) != 1 || ids[0] != 2 {
		t.Fatalf("unexpected UIDs %v: %v", ids, e)
	}
	mu.Lock()
	readsBefore := rawRequests
	mu.Unlock()
	day := time.Date(2026, 10, 7, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name     string
		criteria *imap.SearchCriteria
		want     []uint32
	}{
		{"same day SINCE", &imap.SearchCriteria{Since: day}, []uint32{2}},
		{"ON date", &imap.SearchCriteria{Since: day, Before: day.AddDate(0, 0, 1)}, []uint32{2}},
		{"later SINCE", &imap.SearchCriteria{Since: day.AddDate(0, 0, 1)}, nil},
		{"nested UID star", &imap.SearchCriteria{Not: []*imap.SearchCriteria{{Uid: &imap.SeqSet{Set: []imap.Seq{{Start: 0, Stop: 0}}}}}}, nil},
		{"nested date OR", &imap.SearchCriteria{Or: [][2]*imap.SearchCriteria{{{Before: day}, {Since: day}}}}, []uint32{2}},
	} {
		ids, err := c.UidSearch(test.criteria)
		if err != nil || !slices.Equal(ids, test.want) {
			t.Fatalf("%s: got %v, want %v (%v)", test.name, ids, test.want, err)
		}
	}
	mu.Lock()
	readsAfter := rawRequests
	mu.Unlock()
	if readsAfter != readsBefore {
		t.Fatal("metadata-only SEARCH downloaded message bodies")
	}
	// A real client may send its next command in the same write as DONE.
	wire, err := tls.Dial("tcp", listener.Addr().String(), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	defer wire.Close()
	_ = wire.SetDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReader(wire)
	readUntil := func(prefix string) {
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("waiting for %s: %v", prefix, err)
			}
			if strings.HasPrefix(line, prefix) {
				return
			}
		}
	}
	readUntil("* OK")
	_, _ = io.WriteString(wire, "a LOGIN mail@example.com test-password\r\n")
	readUntil("a OK")
	_, _ = io.WriteString(wire, "b IDLE\r\n")
	readUntil("+")
	_, _ = io.WriteString(wire, "DONE\r\nc NOOP\r\n")
	readUntil("b OK")
	readUntil("c OK")
	if e = c.UidStore(&imap.SeqSet{Set: []imap.Seq{{Start: 2, Stop: 2}}}, imap.AddFlags, []interface{}{imap.DeletedFlag}, nil); e != nil {
		t.Fatal(e)
	}
	if e = c.Expunge(nil); e != nil {
		t.Fatal(e)
	}
	if c.Mailbox().Messages != 0 {
		t.Fatal("expunge notification missing")
	}
	if e = c.Append("Archive", nil, time.Now(), bytes.NewReader(raw)); e != nil {
		t.Fatal(e)
	}
	ids, e = c.UidSearch(imap.NewSearchCriteria())
	if e != nil || len(ids) != 1 || ids[0] != 3 {
		t.Fatalf("APPEND left stale selected state: %v %v", ids, e)
	}
	mu.Lock()
	revoked = true
	mu.Unlock()
	if e = c.Noop(); e == nil {
		t.Fatal("revoked session remained authorized")
	}
}

func TestSequenceStarResolution(t *testing.T) {
	set := &imap.SeqSet{}
	if e := set.Add("99:*"); e != nil {
		t.Fatal(e)
	}
	resolved := resolveSet(set, 7)
	if !resolved.Contains(7) || resolved.Contains(6) {
		t.Fatalf("reverse range star resolved incorrectly: %v", resolved)
	}
}

func TestSMTPSubmission(t *testing.T) {
	var submitted struct {
		Raw        string
		Recipients []string
	}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		username, password, _ := r.BasicAuth()
		if username != "mail@example.com" || password != "test-password" {
			http.Error(w, `{"error":"Invalid login"}`, 401)
			return
		}
		var op struct {
			Action     string
			Raw        string
			Recipients []string
		}
		_ = json.NewDecoder(r.Body).Decode(&op)
		if op.Action == "submit" {
			submitted.Raw = op.Raw
			submitted.Recipients = op.Recipients
		}
		_, _ = io.WriteString(w, `{"status":"accepted"}`)
	}))
	defer worker.Close()
	apiURL = worker.URL
	apiSecret = "test-bridge"
	certServer := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer certServer.Close()
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	s := smtp.NewServer(smtp.BackendFunc(func(c *smtp.Conn) (smtp.Session, error) { return &smtpSession{conn: c}, nil }))
	s.Domain = "localhost"
	s.MaxMessageBytes = 5 * 1024 * 1024
	go s.Serve(tls.NewListener(listener, certServer.TLS))
	defer s.Close()
	conn, e := tls.Dial("tcp", listener.Addr().String(), &tls.Config{InsecureSkipVerify: true})
	if e != nil {
		t.Fatal(e)
	}
	c, e := stdsmtp.NewClient(conn, "localhost")
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	if e = c.Mail("mail@example.com"); e == nil {
		t.Fatal("Unauthenticated relay accepted")
	}
	if ok, mechanisms := c.Extension("AUTH"); !ok || mechanisms != sasl.Plain {
		t.Fatalf("Expected AUTH PLAIN over TLS: %v %s", ok, mechanisms)
	}
	if e = c.Auth(stdsmtp.PlainAuth("", "mail@example.com", "test-password", "localhost")); e != nil {
		t.Fatal(e)
	}
	if e = c.Mail("someone-else@example.com"); e == nil {
		t.Fatal("Cross-mailbox sender accepted")
	}
	if e = c.Mail("mail@example.com"); e != nil {
		t.Fatal(e)
	}
	if e = c.Rcpt("recipient@example.net"); e != nil {
		t.Fatal(e)
	}
	data, e := c.Data()
	if e != nil {
		t.Fatal(e)
	}
	raw := "From: mail@example.com\r\nTo: recipient@example.net\r\nSubject: Local protocol fixture\r\n\r\nNo real mail is sent.\r\n"
	if _, e = io.WriteString(data, raw); e != nil {
		t.Fatal(e)
	}
	if e = data.Close(); e != nil {
		t.Fatal(e)
	}
	decoded, e := base64.StdEncoding.DecodeString(submitted.Raw)
	if e != nil || string(decoded) != raw || !slices.Equal(submitted.Recipients, []string{"recipient@example.net"}) {
		t.Fatal("SMTP envelope or MIME changed")
	}
}
