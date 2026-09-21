package core

import (
	"html"
	"strings"
	"sync"
	"unicode"

	"github.com/markusmobius/go-py3langid"

	nethtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/sanitizer"
)

// Plain turns a title or summary that may carry markup or (doubly) escaped
// entities into plain text — the same treatment Miniflux gives feed titles.
func Plain(s string) string {
	s = sanitizer.StripTags(html.UnescapeString(html.UnescapeString(s)))
	return strings.Join(strings.Fields(html.UnescapeString(s)), " ")
}

var blockTags = map[string]bool{
	"p": true, "div": true, "section": true, "article": true, "blockquote": true, "pre": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
	"li": true, "ul": true, "ol": true, "dl": true, "dt": true, "dd": true,
	"table": true, "tr": true, "figure": true, "figcaption": true, "br": true, "hr": true,
}

// TextOf renders HTML as plain text with one line per block, for AI input and
// word counts. Inline markup is flattened; block boundaries become newlines.
func TextOf(fragment string) string {
	nodes, err := nethtml.ParseFragment(strings.NewReader(fragment), &nethtml.Node{Type: nethtml.ElementNode, Data: "body", DataAtom: atom.Body})
	if err != nil {
		return Plain(fragment)
	}
	var b strings.Builder
	var walk func(n *nethtml.Node)
	walk = func(n *nethtml.Node) {
		switch n.Type {
		case nethtml.TextNode:
			b.WriteString(n.Data)
		case nethtml.ElementNode:
			if n.Data == "script" || n.Data == "style" {
				return
			}
			if blockTags[n.Data] {
				b.WriteString("\n")
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if n.Type == nethtml.ElementNode && blockTags[n.Data] {
			b.WriteString("\n")
		}
	}
	for _, n := range nodes {
		walk(n)
	}
	var lines []string
	for _, line := range strings.Split(b.String(), "\n") {
		if l := strings.Join(strings.Fields(line), " "); l != "" {
			lines = append(lines, l)
		}
	}
	return strings.Join(lines, "\n")
}

func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

// CountWords counts each CJK character as a word and Latin text by words,
// matching countWords in packages/core/src/blocks.ts.
func CountWords(s string) int {
	n, inWord := 0, false
	for _, r := range s {
		switch {
		case isCJK(r):
			n++
			inWord = false
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '\'' || r == '-':
			if !inWord {
				n++
				inWord = true
			}
		default:
			inWord = false
		}
	}
	return n
}

// newsLanguages are the languages news sources in practice publish in. The
// full model knows 139, and on a short headline it will sometimes pick a rare
// neighbour (Aragonese for Spanish, Nigerian Pidgin for English); keeping to
// this list removes those without losing anything real.
var newsLanguages = []string{
	"en", "zh", "ja", "ko", "es", "pt", "fr", "de", "it", "nl", "ru", "uk", "pl", "cs",
	"ro", "hu", "el", "tr", "ar", "fa", "he", "hi", "bn", "ur", "ta", "id", "ms", "vi",
	"th", "tl", "sv", "no", "da", "fi",
}

var langID = sync.OnceValues(func() (*py3langid.Identifier, error) {
	id, err := py3langid.NewDefaultIdentifier(py3langid.WithNormalizedProbabilities())
	if err != nil {
		return nil, err
	}
	return id, id.SetLanguages(newsLanguages...)
})

// minLangConfidence is how sure the classifier must be before its answer
// overrides what the publisher declared. Measured on 200 Reuters headlines:
// above it, detection was right every time.
const minLangConfidence = 0.5

// PickLang decides an item's language from its text, falling back to what the
// page or feed declares. Detection comes first because declarations are often
// wrong: Reuters' news sitemap labels its Spanish and French articles "en".
func PickLang(declared, text string) string {
	if id, err := langID(); err == nil && strings.TrimSpace(text) != "" {
		if r, err := id.IdentifyString(text); err == nil && r.Score >= minLangConfidence && r.Language != "und" && r.Language != "zxx" {
			return NormalizeLang(r.Language)
		}
	}
	return NormalizeLang(declared)
}

// NormalizeLang reduces a declared language such as "en-US" or "zh_CN" to its
// primary subtag, lower-cased.
func NormalizeLang(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if i := strings.IndexAny(s, "-_"); i > 0 {
		s = s[:i]
	}
	if len(s) < 2 || len(s) > 3 {
		return ""
	}
	return s
}

func truncateRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}
