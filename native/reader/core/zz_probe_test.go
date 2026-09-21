package core

import (
	"fmt"
	nurl "net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	trafilatura "github.com/markusmobius/go-trafilatura/v2"
	nethtml "golang.org/x/net/html"
)

func TestProbeFocus(t *testing.T) {
	dir := os.Getenv("PAGES")
	files, _ := filepath.Glob(dir + "/*.html")
	count := func(h, tag string) int { return len(regexp.MustCompile("<"+tag+`[\s>]`).FindAllString(h, -1)) }
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".html")
		body, _ := os.ReadFile(f)
		raw, _ := os.ReadFile(strings.TrimSuffix(f, ".html") + ".url")
		u, _ := nurl.Parse(strings.TrimSpace(string(raw)))
		for _, v := range []struct {
			n  string
			fo trafilatura.ExtractionFocus
			fb bool
		}{{"bal+fb", trafilatura.Balanced, true}, {"prec+fb", trafilatura.FavorPrecision, true}, {"prec", trafilatura.FavorPrecision, false}, {"bal", trafilatura.Balanced, false}} {
			r, err := trafilatura.Extract(strings.NewReader(string(body)), trafilatura.Options{OriginalURL: u, EnableFallback: v.fb, Focus: v.fo, ExcludeComments: true, IncludeImages: true, IncludeLinks: true, Deduplicate: true})
			if err != nil || r.ContentNode == nil {
				fmt.Printf("%-10s %-8s ERR %v\n", name, v.n, err)
				continue
			}
			var b strings.Builder
			nethtml.Render(&b, r.ContentNode)
			h := b.String()
			txt := TextOf(h)
			lines := strings.Split(txt, "\n")
			last := lines[len(lines)-1]
			fmt.Printf("%-10s %-8s words=%4d p=%2d li=%2d img=%2d | last: %.60s\n", name, v.n, CountWords(txt), count(h, "p"), count(h, "li"), count(h, "img"), last)
		}
	}
}
