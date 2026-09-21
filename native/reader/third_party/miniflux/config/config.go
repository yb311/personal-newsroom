// Stand-in for miniflux.app/v2/internal/config, written for this project and
// not synced from upstream (see scripts/sync-miniflux.sh).
//
// The copied reader packages read only a handful of options. Defaults match
// Miniflux's own, and ParseEnvironmentVariables honours the same variable
// names, so Miniflux's tests for these packages run unchanged.
package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"time"
)

type Options struct {
	fetcherAllowPrivateNetworks bool
	httpClientMaxBodySizeMB     int64
	invidiousInstance           string
	youTubeEmbedURLOverride     string
	youTubeEmbedDomain          string
}

// Opts is what the copied packages read. Like upstream it starts out nil, which
// the fetcher treats as "no restrictions"; the reader binary sets it at start-up.
// Getters on a nil *Options return the defaults.
var Opts *Options

var defaults = NewConfigOptions()

func (o *Options) or() *Options {
	if o == nil {
		return defaults
	}
	return o
}

func NewConfigOptions() *Options {
	return &Options{
		httpClientMaxBodySizeMB: 15,
		invidiousInstance:       "yewtu.be",
		youTubeEmbedURLOverride: "https://www.youtube-nocookie.com/embed/",
		youTubeEmbedDomain:      "www.youtube-nocookie.com",
	}
}

func (o *Options) FetcherAllowPrivateNetworks() bool { return o.or().fetcherAllowPrivateNetworks }
func (o *Options) HTTPClientMaxBodySize() int64      { return o.or().httpClientMaxBodySizeMB * 1024 * 1024 }
func (o *Options) InvidiousInstance() string         { return o.or().invidiousInstance }
func (o *Options) YouTubeEmbedUrlOverride() string   { return o.or().youTubeEmbedURLOverride }
func (o *Options) YouTubeEmbedDomain() string        { return o.or().youTubeEmbedDomain }

// Polling-schedule options are referenced by model.Feed but never used here:
// this project schedules fetching itself. Miniflux's defaults are returned.
func (o *Options) PollingScheduler() string                          { return "round_robin" }
func (o *Options) SchedulerEntryFrequencyFactor() int                { return 1 }
func (o *Options) SchedulerEntryFrequencyMaxInterval() time.Duration { return 24 * time.Hour }
func (o *Options) SchedulerEntryFrequencyMinInterval() time.Duration { return 5 * time.Minute }
func (o *Options) SchedulerRoundRobinMaxInterval() time.Duration     { return 24 * time.Hour }
func (o *Options) SchedulerRoundRobinMinInterval() time.Duration     { return time.Hour }

type Parser struct{}

func NewConfigParser() *Parser { return &Parser{} }

func (p *Parser) ParseEnvironmentVariables() (*Options, error) {
	o := NewConfigOptions()
	if v, ok := os.LookupEnv("FETCHER_ALLOW_PRIVATE_NETWORKS"); ok {
		o.fetcherAllowPrivateNetworks = v == "1" || v == "true" || v == "yes" || v == "on"
	}
	if v, ok := os.LookupEnv("HTTP_CLIENT_MAX_BODY_SIZE"); ok {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			return nil, fmt.Errorf("invalid HTTP_CLIENT_MAX_BODY_SIZE: %q", v)
		}
		o.httpClientMaxBodySizeMB = n
	}
	if v, ok := os.LookupEnv("INVIDIOUS_INSTANCE"); ok {
		o.invidiousInstance = v
	}
	if v, ok := os.LookupEnv("YOUTUBE_EMBED_URL_OVERRIDE"); ok {
		u, err := url.Parse(v)
		if err != nil {
			return nil, fmt.Errorf("invalid YOUTUBE_EMBED_URL_OVERRIDE: %v", err)
		}
		o.youTubeEmbedURLOverride = v
		o.youTubeEmbedDomain = u.Hostname()
	}
	return o, nil
}
