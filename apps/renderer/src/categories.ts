const labels: Record<string, string> = {
  world: '国际新闻', news: '综合新闻', tech: '科技', 'business-economy': '商业与经济',
  android: 'Android', 'android-development': 'Android 开发', 'animal-wildlife': '动物与野生自然',
  apple: 'Apple', architecture: '建筑', beauty: '美妆', books: '图书', cars: '汽车',
  chess: '国际象棋', cricket: '板球', cryptocurrency: '加密货币', 'cyber-security': '网络安全',
  diy: '手工制作', environment: '环境', fashion: '时尚', food: '美食', football: '足球',
  funny: '趣闻', gaming: '游戏', history: '历史', 'interior-design': '室内设计',
  'ios-development': 'iOS 开发', memes: '网络文化', movies: '电影', music: '音乐',
  nature: '自然', 'personal-finance': '个人理财', photography: '摄影', programming: '编程',
  science: '科学', space: '太空', sports: '体育', startups: '创业', television: '电视',
  tennis: '网球', travel: '旅行', 'ui-ux': '产品设计', 'web-development': '网页开发',
};
export const categoryLabel = (category: string | null): string => category ? labels[category] ?? category : '其他';

/** Translate a uniquely matched display label for the existing catalogue search. */
export function categorySearchTerm(query: string): string {
  const term = query.trim();
  const matches = Object.entries(labels).filter(([, label]) => label.includes(term));
  return term && matches.length === 1 ? matches[0]![0] : query;
}
