package core

import (
	"bytes"
	"strings"
	"time"

	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/parser"
)

// Item is one entry from a feed or news sitemap, already cleaned.
type Item struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	PublishedAt string `json:"publishedAt"`
	// DateEstimated: the source gave no usable date and PublishedAt is when we
	// saw the item. Dates are never invented; this flag is shown as "发现于".
	DateEstimated bool   `json:"dateEstimated,omitempty"`
	Author        string `json:"author,omitempty"`
	Summary       string `json:"summary,omitempty"`
	// Content is the feed's own body, cleaned. Many feeds carry the whole
	// article here, in which case the page never needs to be fetched.
	ContentHTML string `json:"contentHtml,omitempty"`
	ContentText string `json:"contentText,omitempty"`
	Words       int    `json:"words"`
	ImageURL    string `json:"imageUrl,omitempty"`
	Lang        string `json:"lang,omitempty"`
}

// FeedResult is what one feed or sitemap body produced.
type FeedResult struct {
	Items   []Item         `json:"items"`
	Fetched int            `json:"fetched"`
	Dropped map[string]int `json:"dropped"`
	// Children lists child sitemaps when the body was a sitemap index; the
	// caller downloads them and parses each as kind "sitemap".
	Children []string `json:"children,omitempty"`
}

const summaryRunes = 600

// ParseFeed parses a downloaded body. kind is "feed" (RSS, Atom, RDF or JSON
// Feed, detected from the content), "sitemap" (a Google News sitemap) or
// "sitemap_index". Downloading is the caller's job: some publishers only
// answer clients whose TLS handshake they recognise, which the app's own
// network stack gets past and Go's does not.
func ParseFeed(baseURL, kind string, body []byte) (*FeedResult, error) {
	res := &FeedResult{Dropped: map[string]int{}, Items: []Item{}}
	switch kind {
	case "sitemap":
		return res, parseSitemap(body, res)
	case "sitemap_index":
		return res, parseSitemapIndex(body, res)
	default:
		return res, parseFeedBody(baseURL, body, res)
	}
}

func parseFeedBody(baseURL string, body []byte, res *FeedResult) error {
	// Miniflux stamps undated entries with the parse time. Anything dated at or
	// after this instant therefore had no usable date of its own.
	parseStart := time.Now()
	feed, err := parser.ParseFeed(baseURL, bytes.NewReader(body))
	if err != nil {
		return fail("parse_error", err.Error())
	}
	feedLang := NormalizeLang(feed.Language)
	res.Fetched = len(feed.Entries)
	for _, e := range feed.Entries {
		if !strings.HasPrefix(e.URL, "http://") && !strings.HasPrefix(e.URL, "https://") {
			res.Dropped["no_url"]++
			continue
		}
		title := Plain(e.Title)
		if title == "" || title == e.URL {
			res.Dropped["no_title"]++
			continue
		}
		it := Item{Title: title, URL: e.URL, Author: Plain(e.Author)}
		if e.Date.IsZero() || !e.Date.Before(parseStart) {
			it.DateEstimated = true
			res.Dropped["date_estimated"]++
			it.PublishedAt = parseStart.UTC().Format(time.RFC3339)
		} else {
			it.PublishedAt = e.Date.UTC().Format(time.RFC3339)
		}
		if e.Content != "" {
			c := Clean(e.URL, e.Content)
			it.ContentHTML, it.ContentText, it.Words = c.HTML, c.Text, c.Words
			it.Summary = truncateRunes(strings.ReplaceAll(c.Text, "\n", " "), summaryRunes)
		}
		for _, enc := range e.Enclosures {
			if enc.URL != "" && enc.IsImage() {
				it.ImageURL = enc.URL
				break
			}
		}
		declared := e.Language
		if declared == "" {
			declared = feedLang
		}
		it.Lang = PickLang(declared, title+". "+it.Summary)
		res.Items = append(res.Items, it)
	}
	return nil
}
