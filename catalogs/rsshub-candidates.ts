/**
 * RSSHub routes worth offering in the app, by platform. Only the choice lives
 * here: names, parameter descriptions, examples and URL-recognition rules come
 * from RSSHub's own route metadata, and catalogs/verify-rsshub.ts keeps only
 * routes that need no cookie, key or browser and return items when tried.
 *
 * Order matters within a platform: when a pasted URL fits several routes
 * (a Bilibili space page fits "videos", "articles", "likes" …), the first one
 * listed wins.
 */
export interface Candidate { platform: string; path: string; name?: string }

const c = (platform: string, paths: (string | [string, string])[]): Candidate[] =>
  paths.map((p) => (Array.isArray(p) ? { platform, path: p[0], name: p[1] } : { platform, path: p }));

export const CANDIDATES: Candidate[] = [
  ...c('哔哩哔哩', [
    ['/bilibili/user/video/:uid/:embed?', 'UP 主投稿'], ['/bilibili/user/article/:uid', 'UP 主专栏'],
    ['/bilibili/popular/all/:embed?', '综合热门'], ['/bilibili/weekly/:embed?', '每周必看'], ['/bilibili/precious/:embed?', '入站必刷'],
    ['/bilibili/ranking/:rid?/:embed?/:redirect1?/:redirect2?', '排行榜'], ['/bilibili/hot-search', '热搜'],
    ['/bilibili/partion/:tid/:embed?', '分区视频'], ['/bilibili/live/room/:roomID', '直播开播提醒']
  ]),
  ...c('知乎', [
    ['/zhihu/daily', '知乎日报'], ['/zhihu/pin/daily', '想法 · 24 小时新闻汇总'],
    ['/zhihu/xhu/zhuanlan/:id', '专栏'], ['/zhihu/xhu/people/activities/:hexId', '用户动态'],
    ['/zhihu/xhu/question/:questionId/:sortBy?', '问题'], ['/zhihu/xhu/topic/:topicId', '话题']
  ]),
  ...c('36氪', [['/36kr/:category/:subCategory?/:keyword?', '资讯 / 快讯'], ['/36kr/hot-list/:category?', '热榜']]),
  ...c('少数派', [['/sspai/index', '首页'], ['/sspai/matrix', 'Matrix 社区'], ['/sspai/author/:id', '作者'],
                  ['/sspai/tag/:keyword', '标签'], ['/sspai/topics', '专题'], ['/sspai/topic/:id', '专题文章']]),
  ...c('掘金', [['/juejin/category/:category', '分类'], ['/juejin/tag/:tag', '标签'], ['/juejin/posts/:id', '用户文章'],
                ['/juejin/trending/:category/:type', '热门']]),
  ...c('V2EX', [['/v2ex/topics/:type', '最热 / 最新主题'], ['/v2ex/tab/:tabid', '标签页']]),
  ...c('豆瓣', [['/douban/movie/playing', '正在上映'], ['/douban/movie/coming', '即将上映'], ['/douban/movie/weekly/:type?', '一周口碑榜'],
                ['/douban/book/latest/:type?', '新书速递'], ['/douban/list/:type?/:routeParams?', '榜单与集合'],
                ['/douban/group/:groupid/:type?', '小组']]),
  ...c('澎湃新闻', [['/thepaper/featured', '首页头条'], ['/thepaper/channel/:id', '频道'], ['/thepaper/list/:id', '栏目']]),
  ...c('财联社', [['/cls/telegraph/:category?', '电报'], ['/cls/depth/:category?', '深度']]),
  ...c('华尔街见闻', [['/wallstreetcn/live/:category?/:score?', '实时快讯'], ['/wallstreetcn/news/:category?', '资讯'],
                      ['/wallstreetcn/hot/:period?', '最热文章']]),
  ...c('雪球', [['/xueqiu/hots', '热帖'], ['/xueqiu/stock_comments/:id', '股票讨论']]),
  ...c('爱范儿', [['/ifanr/index', '首页'], ['/ifanr/digest', '快讯']]),
  ...c('极客公园', [['/geekpark/:column?', '栏目']]),
  ...c('联合早报', [['/zaobao/realtime/:section?', '即时新闻'], ['/zaobao/znews/:section?', '新闻']]),
  ...c('南方周末', [['/infzm/hot', '热门文章'], ['/infzm/:id', '频道']]),
  ...c('IT之家', [['/ithome/ranking/:type', '热榜'], ['/ithome/tag/:name', '标签']]),
  ...c('GitHub', [['/github/issue/:user/:repo/:state?/:labels?', '仓库 Issues'], ['/github/topics/:name/:qs?', '主题下的仓库'],
                  ['/github/search/:query/:sort?/:order?', '仓库搜索']]),
  ...c('Product Hunt', [['/producthunt/today', '今日新品']]),
  ...c('小宇宙', [['/xiaoyuzhou/podcast/:id', '播客节目'], ['/xiaoyuzhou/', '发现']]),
  ...c('即刻', [['/jike/topic/:id/:showUid?', '圈子'], ['/jike/user/:id', '用户动态']]),
  ...c('Solidot', [['/solidot/:type?', '最新消息']])
];
