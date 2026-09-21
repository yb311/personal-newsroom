package core

import (
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestFeedTitlesAreDecoded(t *testing.T) {
	// USA Today and DW escape entities twice: &amp;#39; arrives as &#39; after XML parsing.
	feed := `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Wan&amp;#39;Dale Robinson finishes with one catch</title><link>https://example.com/a</link>
<pubDate>Sun, 20 Sep 2026 10:00:00 GMT</pubDate><description>Iran&amp;#039;s &lt;b&gt;decision&lt;/b&gt;</description></item>
</channel></rss>`
	res, err := ParseFeed("https://example.com/feed", "feed", []byte(feed))
	if err != nil {
		t.Fatal(err)
	}
	it := res.Items[0]
	if it.Title != "Wan'Dale Robinson finishes with one catch" {
		t.Errorf("title = %q", it.Title)
	}
	if it.Summary != "Iran's decision" {
		t.Errorf("summary = %q", it.Summary)
	}
}

func TestLegacyChineseEncoding(t *testing.T) {
	// Declared only in the XML prolog, never in an HTTP header.
	utf8 := `<?xml version="1.0" encoding="gb2312"?><rss version="2.0"><channel><title>央广网</title>
<item><title>全国秋粮收获进度过半</title><link>https://example.cn/1.shtml</link>
<pubDate>Sun, 20 Sep 2026 10:00:00 +0800</pubDate></item></channel></rss>`
	gb, err := simplifiedchinese.GBK.NewEncoder().String(utf8)
	if err != nil {
		t.Fatal(err)
	}
	res, err := ParseFeed("https://example.cn/rss.xml", "feed", []byte(gb))
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Items[0].Title; got != "全国秋粮收获进度过半" {
		t.Errorf("title = %q", got)
	}
	if res.Items[0].Lang != "zh" {
		t.Errorf("lang = %q", res.Items[0].Lang)
	}
}

func TestUndatedItemsAreFlaggedNotInvented(t *testing.T) {
	feed := `<rss version="2.0"><channel><title>t</title>
<item><title>No date here</title><link>https://example.com/b</link></item></channel></rss>`
	res, err := ParseFeed("https://example.com/feed", "feed", []byte(feed))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Items[0].DateEstimated {
		t.Error("an undated item must be flagged as estimated")
	}
}

func TestSitemapLanguageBeatsWrongDeclaration(t *testing.T) {
	// Reuters labels its Spanish articles "en".
	sm := `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
<url><loc>https://example.com/es/1</loc><news:news><news:publication><news:language>en</news:language></news:publication>
<news:publication_date>2026-09-20T10:00:00Z</news:publication_date>
<news:title>Boca Juniors vence a San Lorenzo en clásico de fútbol argentino</news:title></news:news></url>
<url><loc>https://example.com/en/2</loc><news:news><news:publication><news:language>en</news:language></news:publication>
<news:publication_date>2026-09-20T10:00:00Z</news:publication_date>
<news:title>Taiwan minister makes rare trip to China for APEC meeting</news:title></news:news></url>
</urlset>`
	res, err := ParseFeed("https://example.com/sitemap.xml", "sitemap", []byte(sm))
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Items[0].Lang; got != "es" {
		t.Errorf("spanish headline lang = %q", got)
	}
	if got := res.Items[1].Lang; got != "en" {
		t.Errorf("english headline lang = %q", got)
	}
}

func TestSitemapIndexListsChildren(t *testing.T) {
	idx := `<sitemapindex><sitemap><loc>https://x/1.xml</loc></sitemap><sitemap><loc>https://x/2.xml</loc></sitemap></sitemapindex>`
	res, err := ParseFeed("https://x/index.xml", "sitemap_index", []byte(idx))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(res.Children, ",") != "https://x/1.xml,https://x/2.xml" {
		t.Errorf("children = %v", res.Children)
	}
}

func TestTidyDropsFurnitureKeepsPhotos(t *testing.T) {
	in := `<h1>Merz vows to stay on</h1><img src="https://cdn.x/p.jpg?width=48&height=48" alt="Portrait of A">A. Writer` +
		`<p>First paragraph.</p><p><img src="https://x/logo.png"></p><figure><img src="https://cdn.x/photo.jpg"></figure>` +
		`<figure><img src="https://cdn.x/photo.jpg?w=1200"></figure>`
	out := Tidy(in, "Merz vows to stay on", "A. Writer")
	for _, gone := range []string{"<h1>", "Portrait", "A. Writer", "logo.png"} {
		if strings.Contains(out, gone) {
			t.Errorf("kept %q in %s", gone, out)
		}
	}
	if strings.Count(out, "photo.jpg") != 1 {
		t.Errorf("want the photo exactly once: %s", out)
	}
	if !strings.Contains(out, "First paragraph.") {
		t.Errorf("lost the text: %s", out)
	}
}
