package core

// Acceptance benchmark for article extraction.
//
// Each case is a page saved exactly as the app downloaded it
// (testdata/articles/<name>.html.gz) plus a manifest (<name>.json) written by a
// person who read the page:
//
//	body         CSS selector(s) of the real article text — the reference
//	exclude      selectors inside it that are not the article (ads, share bars)
//	mustContain  phrases the extraction has to keep
//	mustNot      phrases it must drop (navigation, subscription pitches, …)
//
// Scoring is word-level F1 between the extracted text and the reference, the
// metric the WCXB benchmark uses (CJK characters count as words). The bar is a
// mean F1 of 0.9 over all cases; run with -v for the per-page table.

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"unicode"

	"github.com/PuerkitoBio/goquery"

	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/encoding"
)

type benchCase struct {
	URL         string   `json:"url"`
	ContentType string   `json:"contentType"`
	Body        string   `json:"body"`
	Exclude     string   `json:"exclude,omitempty"`
	MustContain []string `json:"mustContain,omitempty"`
	MustNot     []string `json:"mustNot,omitempty"`
	Note        string   `json:"note,omitempty"`
}

const minMeanF1 = 0.9

func tokens(s string) map[string]int {
	out := map[string]int{}
	var w strings.Builder
	flush := func() {
		if w.Len() > 0 {
			out[w.String()]++
			w.Reset()
		}
	}
	for _, r := range strings.ToLower(s) {
		switch {
		case isCJK(r):
			flush()
			out[string(r)]++
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			w.WriteRune(r)
		default:
			flush()
		}
	}
	flush()
	return out
}

func f1(got, want map[string]int) (p, r, f float64) {
	var inter, ng, nw int
	for k, n := range got {
		ng += n
		inter += min(n, want[k])
	}
	for _, n := range want {
		nw += n
	}
	if ng == 0 || nw == 0 {
		return 0, 0, 0
	}
	p, r = float64(inter)/float64(ng), float64(inter)/float64(nw)
	if p+r == 0 {
		return p, r, 0
	}
	return p, r, 2 * p * r / (p + r)
}

func readPage(t *testing.T, path string) []byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// reference is the text of the annotated article container, minus excluded parts.
func reference(t *testing.T, raw []byte, c benchCase) string {
	t.Helper()
	r, err := encoding.NewCharsetReaderFromBytes(raw, c.ContentType)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := goquery.NewDocumentFromReader(r)
	if err != nil {
		t.Fatal(err)
	}
	body := doc.Find(c.Body)
	if body.Length() == 0 {
		t.Fatalf("body selector %q matches nothing", c.Body)
	}
	body.Find("script, style, noscript, template").Remove()
	if c.Exclude != "" {
		body.Find(c.Exclude).Remove()
	}
	var b strings.Builder
	body.Each(func(_ int, s *goquery.Selection) {
		if h, err := goquery.OuterHtml(s); err == nil {
			b.WriteString(TextOf(h))
			b.WriteString("\n")
		}
	})
	return b.String()
}

func TestExtractionBenchmark(t *testing.T) {
	manifests, _ := filepath.Glob("testdata/articles/*.json")
	if len(manifests) == 0 {
		t.Skip("no fixtures")
	}
	type row struct {
		name     string
		p, r, f  float64
		got, ref int
	}
	var rows []row
	var sum float64
	for _, m := range manifests {
		name := strings.TrimSuffix(filepath.Base(m), ".json")
		var c benchCase
		raw, _ := os.ReadFile(m)
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		page := readPage(t, strings.TrimSuffix(m, ".json")+".html.gz")
		a, err := Extract(c.URL, page, c.ContentType)
		if err != nil {
			t.Errorf("%s: extract failed: %v", name, err)
			rows = append(rows, row{name: name})
			continue
		}
		want := reference(t, page, c)
		got := tokens(a.Text)
		p, r, f := f1(got, tokens(want))
		sum += f
		rows = append(rows, row{name, p, r, f, a.Words, CountWords(want)})

		norm := func(s string) string { return strings.Join(strings.Fields(s), " ") }
		text := norm(a.Text)
		for _, s := range c.MustContain {
			if !strings.Contains(text, norm(s)) {
				t.Errorf("%s: lost %q", name, s)
			}
		}
		for _, s := range c.MustNot {
			if strings.Contains(text, norm(s)) || strings.Contains(a.HTML, s) {
				t.Errorf("%s: kept %q", name, s)
			}
		}
		if os.Getenv("BENCH_DIFF") == name {
			diff(t, a.Text, want)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].f < rows[j].f })
	for _, r := range rows {
		t.Logf("%-16s F1 %.3f  P %.3f  R %.3f  words %5d / ref %5d", r.name, r.f, r.p, r.r, r.got, r.ref)
	}
	mean := sum / float64(len(rows))
	t.Logf("mean F1 %.3f over %d pages (bar %.2f)", mean, len(rows), minMeanF1)
	if mean < minMeanF1 {
		t.Errorf("mean F1 %.3f below %.2f", mean, minMeanF1)
	}
}

// diff prints lines only in the extraction (precision loss) and only in the
// reference (recall loss). Set BENCH_DIFF=<name> to see it for one page.
func diff(t *testing.T, got, want string) {
	lines := func(s string) map[string]bool {
		m := map[string]bool{}
		for _, l := range strings.Split(s, "\n") {
			if l = strings.Join(strings.Fields(l), " "); l != "" {
				m[l] = true
			}
		}
		return m
	}
	g, w := lines(got), lines(want)
	var extra, missing bytes.Buffer
	for l := range g {
		if !strings.Contains(strings.Join(strings.Fields(want), " "), l) {
			fmt.Fprintf(&extra, "  + %.120s\n", l)
		}
	}
	for l := range w {
		if !strings.Contains(strings.Join(strings.Fields(got), " "), l) {
			fmt.Fprintf(&missing, "  - %.120s\n", l)
		}
	}
	t.Logf("only in extraction:\n%s\nonly in reference:\n%s", extra.String(), missing.String())
}
