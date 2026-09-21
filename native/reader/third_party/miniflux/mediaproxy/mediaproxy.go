// Stand-in for miniflux.app/v2/internal/mediaproxy, written for this project
// and not synced from upstream (see scripts/sync-miniflux.sh). There is no
// media proxy in a desktop app; media URLs are used as they are.
package mediaproxy

func ShouldProxifyURLWithMimeType(mediaURL, mediaMimeType, mediaProxyOption string, mediaProxyResourceTypes []string) bool {
	return false
}

func ProxifyAbsoluteURL(mediaURL string) string { return mediaURL }
