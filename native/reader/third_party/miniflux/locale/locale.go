// Stand-in for miniflux.app/v2/internal/locale, written for this project and
// not synced from upstream (see scripts/sync-miniflux.sh).
//
// Miniflux wraps errors with a translation key for its own web UI. This app
// shows its own messages, so the key is kept as a stable reason code instead of
// being translated.
package locale

import "fmt"

type LocalizedErrorWrapper struct {
	originalErr     error
	translationKey  string
	translationArgs []any
}

func NewLocalizedErrorWrapper(originalErr error, translationKey string, translationArgs ...any) *LocalizedErrorWrapper {
	return &LocalizedErrorWrapper{originalErr: originalErr, translationKey: translationKey, translationArgs: translationArgs}
}

func (l *LocalizedErrorWrapper) Error() error { return l.originalErr }

// Key is the Miniflux translation key, e.g. "error.http_not_found".
func (l *LocalizedErrorWrapper) Key() string { return l.translationKey }

func (l *LocalizedErrorWrapper) Translate(string) string {
	if l.translationKey == "" {
		if l.originalErr == nil {
			return ""
		}
		return l.originalErr.Error()
	}
	return fmt.Sprintf("%s %v", l.translationKey, l.translationArgs)
}
