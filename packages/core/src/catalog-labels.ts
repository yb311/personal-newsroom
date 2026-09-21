/**
 * Display names and search words for the built-in catalogue, shared by the main
 * process (which searches) and the UI (which shows labels). The catalogue
 * stores category keys and country names in English; people search in Chinese.
 *
 * Browser-safe: no Node APIs, so the renderer imports it directly
 * (`@pnr/core/catalog-labels`).
 */

/** Category key → Chinese label, then other words people use for it. */
export const CATEGORIES: Record<string, [label: string, ...synonyms: string[]]> = {
  world: ['国际新闻', '国际', '世界', '全球', '外媒', '海外', 'world', 'international'],
  news: ['综合新闻', '综合', '新闻', '时事', '头条', 'news'],
  tech: ['科技', '技术', '互联网', 'IT', 'technology'],
  'business-economy': ['商业与经济', '财经', '经济', '商业', '金融', '市场', 'business', 'economy', 'finance'],
  android: ['Android', '安卓'],
  'android-development': ['Android 开发', '安卓开发'],
  'animal-wildlife': ['动物与野生自然', '动物', '野生动物'],
  apple: ['Apple', '苹果', 'iPhone', 'Mac'],
  architecture: ['建筑'],
  beauty: ['美妆', '化妆', '护肤'],
  books: ['图书', '读书', '书评', '阅读'],
  cars: ['汽车', '车'],
  chess: ['国际象棋', '象棋'],
  cricket: ['板球'],
  cryptocurrency: ['加密货币', '区块链', '比特币', 'crypto'],
  'cyber-security': ['网络安全', '安全', '信息安全', '黑客', 'security'],
  diy: ['手工制作', '手工', 'DIY'],
  environment: ['环境', '环保', '气候'],
  fashion: ['时尚', '服饰'],
  food: ['美食', '饮食', '烹饪', '菜谱'],
  football: ['足球'],
  funny: ['趣闻', '搞笑', '幽默'],
  gaming: ['游戏', '电子游戏'],
  history: ['历史'],
  'interior-design': ['室内设计', '家居'],
  'ios-development': ['iOS 开发', '苹果开发'],
  memes: ['网络文化', '梗'],
  movies: ['电影', '影视'],
  music: ['音乐'],
  nature: ['自然'],
  'personal-finance': ['个人理财', '理财', '投资'],
  photography: ['摄影', '照片'],
  programming: ['编程', '程序员', '开发', '代码'],
  science: ['科学', '科研', '研究'],
  space: ['太空', '航天', '天文'],
  sports: ['体育', '运动'],
  startups: ['创业', '初创'],
  television: ['电视', '剧集'],
  tennis: ['网球'],
  travel: ['旅行', '旅游'],
  'ui-ux': ['产品设计', '设计', '交互'],
  'web-development': ['网页开发', '前端', 'Web'],
  custom: ['自定义', 'custom']
};

/** Country as stored in the catalogue → Chinese name. */
export const COUNTRIES: Record<string, string> = {
  'United States': '美国', 'United Kingdom': '英国', Australia: '澳大利亚', Canada: '加拿大',
  India: '印度', Italy: '意大利', Mexico: '墨西哥', 'South Africa': '南非', Iran: '伊朗',
  Bangladesh: '孟加拉国', Philippines: '菲律宾', Ukraine: '乌克兰', Nigeria: '尼日利亚',
  Spain: '西班牙', Pakistan: '巴基斯坦', Germany: '德国', Ireland: '爱尔兰', Japan: '日本',
  Brazil: '巴西', 'Hong Kong SAR China': '中国香港', France: '法国', Russia: '俄罗斯',
  Poland: '波兰', Indonesia: '印度尼西亚', China: '中国', Taiwan: '中国台湾', Singapore: '新加坡',
  Korea: '韩国', 'South Korea': '韩国'
};

/** English labels where title-casing the key would read wrong. */
const CATEGORY_EN: Record<string, string> = {
  tech: 'Technology', 'business-economy': 'Business & Economy', 'animal-wildlife': 'Animals & Wildlife',
  diy: 'DIY', 'ios-development': 'iOS Development', 'ui-ux': 'UI/UX', 'cyber-security': 'Cybersecurity',
  memes: 'Internet Culture', funny: 'Offbeat', 'personal-finance': 'Personal Finance'
};
const titleCase = (key: string): string => key.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
const isZh = (lang?: string): boolean => !lang || lang.startsWith('zh');

/** Display name of a category in the interface language (Chinese by default). */
export const categoryLabel = (key: string | null, lang?: string): string =>
  !key ? (isZh(lang) ? '其他' : 'Other')
    : isZh(lang) ? CATEGORIES[key]?.[0] ?? key
    : CATEGORY_EN[key] ?? (CATEGORIES[key] ? titleCase(key) : key);

/** The catalogue stores countries in English; Chinese gets its own names. */
export const countryLabel = (name: string | null, lang?: string): string | null =>
  name ? (isZh(lang) ? COUNTRIES[name] ?? name : name) : null;
