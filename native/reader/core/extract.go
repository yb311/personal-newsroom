package core

import (
	"io"
	nurl "net/url"
	"strings"
	"time"

	trafilatura "github.com/markusmobius/go-trafilatura/v2"
	nethtml "golang.org/x/net/html"

	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/encoding"
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/scraper"
)

// Article is the extracted body of one web page.
type Article struct {
	URL         string `json:"url"`
	HTML        string `json:"html"`
	Text        string `json:"text"`
	Words       int    `json:"words"`
	Title       string `json:"title,omitempty"`
	Author      string `json:"author,omitempty"`
	PublishedAt string `json:"publishedAt,omitempty"`
	Image       string `json:"image,omitempty"`
	Lang        string `json:"lang,omitempty"`
	// Engine is "rules" when a Miniflux site selector picked the body, or
	// "trafilatura" otherwise.
	Engine string `json:"engine"`
}

// Extract returns the article body of a downloaded page. pageURL is the URL
// the page was finally served from (after redirects); contentType is the
// response header, used together with the page's own declarations to decode
// legacy charsets such as GBK or Big5.
func Extract(pageURL string, rawHTML []byte, contentType string) (*Article, error) {
	finalURL := pageURL
	if ct := strings.ToLower(contentType); ct != "" && !strings.Contains(ct, "html") {
		return nil, fail("not_html", contentType)
	}

	utf8Reader, err := encoding.NewCharsetReaderFromBytes(rawHTML, contentType)
	if err != nil {
		return nil, fail("encoding", err.Error())
	}
	doc, err := io.ReadAll(utf8Reader)
	if err != nil {
		return nil, fail("encoding", err.Error())
	}
	page := string(doc)

	parsedURL, _ := nurl.Parse(finalURL)
	result, trafErr := trafilatura.Extract(strings.NewReader(page), trafilatura.Options{
		OriginalURL:     parsedURL,
		InputEncoding:   "utf-8",
		EnableFallback:  true,
		ExcludeComments: true,
		IncludeImages:   true,
		IncludeLinks:    true,
		Deduplicate:     true,
		Focus:           trafilatura.FavorPrecision,
	})

	a := &Article{URL: finalURL}
	var body string
	// Miniflux's hand-maintained selectors know specific sites better than any
	// general algorithm, so they win when one exists for this site.
	if rules := rulesFor(finalURL); rules != "" {
		if _, content, err := scraper.ContentUsingRules(strings.NewReader(page), rules); err == nil && strings.TrimSpace(content) != "" {
			body, a.Engine = content, "rules"
		}
	}
	if body == "" && trafErr == nil && result != nil && result.ContentNode != nil {
		var b strings.Builder
		if err := nethtml.Render(&b, result.ContentNode); err == nil {
			body, a.Engine = b.String(), "trafilatura"
		}
	}
	if body == "" {
		detail := "empty"
		if trafErr != nil {
			detail = trafErr.Error()
		}
		return nil, fail("no_content", detail)
	}

	if result != nil {
		m := result.Metadata
		a.Title, a.Author, a.Image = Plain(m.Title), Plain(m.Author), m.Image
		if !m.Date.IsZero() {
			a.PublishedAt = m.Date.UTC().Format(time.RFC3339)
		}
		a.Lang = m.Language
	}
	a.HTML = Tidy(Clean(finalURL, body).HTML, a.Title, a.Author)
	a.Text = TextOf(a.HTML)
	a.Words = CountWords(a.Text)
	a.Lang = PickLang(a.Lang, truncateRunes(a.Text, 2000))
	return a, nil
}
