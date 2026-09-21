// pnr-reader is the reader core the app runs as a long-lived child process.
//
// It never touches the network: the app downloads feeds and pages and sends
// the bytes here, which keeps every result reproducible from a saved file.
//
// Protocol: one JSON request per line on stdin, one JSON response per line on
// stdout, matched by id. Requests run concurrently (bounded), so responses can
// arrive out of order. Byte fields are base64, as encoding/json expects.
//
//	→ {"id":1,"method":"parseFeed","params":{"baseUrl":"…","kind":"feed","body":"PD94…"}}
//	← {"id":1,"result":{…}}   or   {"id":1,"error":{"reason":"parse_error","detail":"…"}}
//
// For manual testing on saved files:
//
//	pnr-reader feed <file> <url> [feed|sitemap|sitemap_index]
//	pnr-reader extract <file> <url> [content-type]
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"

	"github.com/yb311/personal-newsroom/native/reader/core"
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/config"
)

type request struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type response struct {
	ID     int64         `json:"id"`
	Result any           `json:"result,omitempty"`
	Error  *core.Failure `json:"error,omitempty"`
}

type cleanInput struct {
	BaseURL string `json:"baseUrl"`
	HTML    string `json:"html"`
}

func handle(method string, params json.RawMessage) (any, error) {
	switch method {
	case "parseFeed":
		var p struct {
			BaseURL string
			Kind    string
			Body    []byte
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return core.ParseFeed(p.BaseURL, p.Kind, p.Body)
	case "extract":
		var p struct {
			URL         string
			Body        []byte
			ContentType string
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return core.Extract(p.URL, p.Body, p.ContentType)
	case "clean":
		var p struct{ Items []cleanInput }
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		out := make([]core.Cleaned, len(p.Items))
		for i, it := range p.Items {
			out[i] = core.Clean(it.BaseURL, it.HTML)
		}
		return out, nil
	case "plain":
		var p struct{ Texts []string }
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		out := make([]string, len(p.Texts))
		for i, t := range p.Texts {
			out[i] = core.Plain(t)
		}
		return out, nil
	case "ping":
		return "pong", nil
	}
	return nil, fmt.Errorf("unknown method %q", method)
}

func toFailure(err error) *core.Failure {
	var f *core.Failure
	if errors.As(err, &f) {
		return f
	}
	return &core.Failure{Reason: "internal", Detail: err.Error()}
}

func serve(in io.Reader, out io.Writer) {
	var mu sync.Mutex
	enc := json.NewEncoder(out)
	write := func(r response) {
		mu.Lock()
		defer mu.Unlock()
		_ = enc.Encode(r)
	}
	slots := make(chan struct{}, 12)
	var wg sync.WaitGroup
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		var req request
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			write(response{ID: -1, Error: &core.Failure{Reason: "bad_request", Detail: err.Error()}})
			continue
		}
		slots <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-slots; wg.Done() }()
			defer func() {
				if p := recover(); p != nil {
					write(response{ID: req.ID, Error: &core.Failure{Reason: "internal", Detail: fmt.Sprint(p)}})
				}
			}()
			result, err := handle(req.Method, req.Params)
			if err != nil {
				write(response{ID: req.ID, Error: toFailure(err)})
				return
			}
			write(response{ID: req.ID, Result: result})
		}()
	}
	wg.Wait()
}

func main() {
	// Logs go to stderr so they never corrupt the protocol on stdout.
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	config.Opts = config.NewConfigOptions()

	if len(os.Args) >= 4 {
		body, err := os.ReadFile(os.Args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		extra := ""
		if len(os.Args) >= 5 {
			extra = os.Args[4]
		}
		var result any
		switch os.Args[1] {
		case "feed":
			if extra == "" {
				extra = "feed"
			}
			result, err = core.ParseFeed(os.Args[3], extra, body)
		case "extract":
			result, err = core.Extract(os.Args[3], body, extra)
		default:
			err = fmt.Errorf("unknown command %q", os.Args[1])
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		e := json.NewEncoder(os.Stdout)
		e.SetIndent("", "  ")
		e.SetEscapeHTML(false)
		_ = e.Encode(result)
		return
	}
	serve(os.Stdin, os.Stdout)
}
