package core

import (
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	nethtml "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Tidy removes what every news page repeats around its text and no extractor
// reliably drops: the headline the reader already shows above the body, a
// byline that only names the author, and images that are site furniture rather
// than content. It only removes; it never rewrites what remains.
func Tidy(fragment, title, author string) string {
	ctx := &nethtml.Node{Type: nethtml.ElementNode, Data: "body", DataAtom: atom.Body}
	nodes, err := nethtml.ParseFragment(strings.NewReader(fragment), ctx)
	if err != nil {
		return fragment
	}
	root := &nethtml.Node{Type: nethtml.ElementNode, Data: "div", DataAtom: atom.Div}
	for _, n := range nodes {
		root.AppendChild(n)
	}

	dropLeading(root, title, author)
	seen := map[string]bool{}
	var imgs []*nethtml.Node
	walk(root, func(n *nethtml.Node) {
		if n.Type == nethtml.ElementNode && n.DataAtom == atom.Img {
			imgs = append(imgs, n)
		}
	})
	for _, img := range imgs {
		key := imageKey(attr(img, "src"))
		if key == "" || seen[key] || isFurniture(img) {
			removeWithEmptyParents(img)
			continue
		}
		seen[key] = true
	}

	var b strings.Builder
	for c := root.FirstChild; c != nil; c = c.NextSibling {
		_ = nethtml.Render(&b, c)
	}
	return b.String()
}

// dropLeading removes, from the top of the body, a heading that repeats the
// title and then a line that is only the author's name.
func dropLeading(root *nethtml.Node, title, author string) {
	first := firstContent(root)
	if first != nil && isHeading(first) && sameText(textContent(first), title) {
		first.Parent.RemoveChild(first)
		first = firstContent(root)
	}
	// The author's portrait usually sits right before the name.
	if first != nil && first.Type == nethtml.ElementNode && first.DataAtom == atom.Img && isFurniture(first) {
		first.Parent.RemoveChild(first)
		first = firstContent(root)
	}
	if first != nil && author != "" && sameText(strings.TrimPrefix(strings.TrimSpace(textContent(first)), "By "), author) {
		first.Parent.RemoveChild(first)
	}
}

func firstContent(root *nethtml.Node) *nethtml.Node {
	for c := root.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == nethtml.TextNode && strings.TrimSpace(c.Data) == "" {
			continue
		}
		if c.Type == nethtml.ElementNode || c.Type == nethtml.TextNode {
			return c
		}
	}
	return nil
}

func isHeading(n *nethtml.Node) bool {
	if n.Type != nethtml.ElementNode {
		return false
	}
	switch n.DataAtom {
	case atom.H1, atom.H2, atom.H3:
		return true
	}
	return false
}

// sameText compares ignoring case, spacing and punctuation. A page title often
// carries the site name ("… - BBC News 中文"), so one containing the other
// also counts, provided the shorter one is not trivially short.
func sameText(a, b string) bool {
	norm := func(s string) string {
		return strings.Map(func(r rune) rune {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				return unicode.ToLower(r)
			}
			return -1
		}, Plain(s))
	}
	x, y := norm(a), norm(b)
	if x == "" || y == "" {
		return false
	}
	if x == y {
		return true
	}
	if len([]rune(x)) > len([]rune(y)) {
		x, y = y, x
	}
	return len([]rune(x)) >= 8 && strings.Contains(y, x)
}

var furnitureName = regexp.MustCompile(`(?i)(logo|icon|avatar|sprite|share|button|badge|qr-?code|placeholder|spacer|pixel|blank|loading)`)

// minContentImagePx: anything declared smaller than this is an icon, an avatar
// or a tracker, not a news photo.
const minContentImagePx = 100

// isFurniture reports whether an image is part of the site rather than the
// story: vector graphics, anything declared tiny (as attributes or as the
// resize parameters image CDNs put in the URL), and files or alt texts named
// like logos, icons, avatars, share buttons or QR codes.
func isFurniture(img *nethtml.Node) bool {
	src := attr(img, "src")
	u, err := url.Parse(src)
	if err != nil || u.Scheme == "data" {
		return true
	}
	if strings.EqualFold(path.Ext(u.Path), ".svg") {
		return true
	}
	small := func(v string) bool {
		n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimSpace(v), "px"))
		return err == nil && n > 0 && n < minContentImagePx
	}
	if small(attr(img, "width")) || small(attr(img, "height")) {
		return true
	}
	q := u.Query()
	for _, k := range []string{"width", "w", "height", "h"} {
		if small(q.Get(k)) {
			return true
		}
	}
	return furnitureName.MatchString(path.Base(u.Path)) || furnitureName.MatchString(attr(img, "alt"))
}

// imageKey identifies an image across resize variants of the same file.
func imageKey(src string) string {
	u, err := url.Parse(src)
	if err != nil || src == "" {
		return ""
	}
	return strings.ToLower(u.Host + u.Path)
}

// removeWithEmptyParents removes n and then any ancestor left with no text and
// no other media, so a removed icon does not leave an empty <p> or <figure>.
func removeWithEmptyParents(n *nethtml.Node) {
	parent := n.Parent
	parent.RemoveChild(n)
	for parent != nil && parent.Parent != nil && parent.Type == nethtml.ElementNode && isEmpty(parent) {
		next := parent.Parent
		next.RemoveChild(parent)
		parent = next
	}
}

func isEmpty(n *nethtml.Node) bool {
	empty := true
	walk(n, func(c *nethtml.Node) {
		if c.Type == nethtml.TextNode && strings.TrimSpace(c.Data) != "" {
			empty = false
		}
		if c.Type == nethtml.ElementNode {
			switch c.DataAtom {
			case atom.Img, atom.Video, atom.Audio, atom.Iframe:
				empty = false
			}
		}
	})
	return empty
}

func walk(n *nethtml.Node, fn func(*nethtml.Node)) {
	fn(n)
	for c := n.FirstChild; c != nil; {
		next := c.NextSibling
		walk(c, fn)
		c = next
	}
}

func textContent(n *nethtml.Node) string {
	var b strings.Builder
	walk(n, func(c *nethtml.Node) {
		if c.Type == nethtml.TextNode {
			b.WriteString(c.Data)
		}
	})
	return b.String()
}

func attr(n *nethtml.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}
