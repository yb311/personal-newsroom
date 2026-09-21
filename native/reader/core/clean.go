package core

import (
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/model"
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/rewrite"
	"github.com/yb311/personal-newsroom/native/reader/third_party/miniflux/reader/sanitizer"
)

// Cleaned is HTML that is safe to render, plus its text.
type Cleaned struct {
	HTML  string `json:"html"`
	Text  string `json:"text"`
	Words int    `json:"words"`
}

// Clean applies Miniflux's per-site rewrite rules (lazy images, embeds, ...)
// and then its allow-list sanitizer: no scripts, styles, event handlers or
// tracking pixels; relative URLs resolved against baseURL.
func Clean(baseURL, raw string) Cleaned {
	entry := &model.Entry{URL: baseURL, Content: raw}
	rewrite.ApplyContentRewriteRules(entry, "")
	safe := sanitizer.SanitizeHTML(baseURL, entry.Content, &sanitizer.SanitizerOptions{OpenLinksInNewTab: true})
	text := TextOf(safe)
	return Cleaned{HTML: safe, Text: text, Words: CountWords(text)}
}
