import type { Db } from '@pnr/store';
import { createWatch, listWatches } from './watch.ts';

/**
 * Preset topics are just watches with a pre-written intent sentence.
 *
 * They are not a separate mechanism: ticking one creates the same object that
 * writing a sentence creates, runs down the same pipeline, and exposes the same
 * editable settings. Presets are the one-click floor; a sentence is the ceiling.
 *
 * Keywords serve two purposes: with AI off they are how the watch matches
 * (labelled as such in the UI), with AI on they only widen recall. They are in
 * Chinese and English because the sources are.
 */
export interface Preset { id: string; group: string; label: string; intent: string; keywords: string[] }

const p = (id: string, group: string, label: string, intent: string, keywords: string[]): Preset =>
  ({ id, group, label, intent, keywords });

export const PRESET_GROUPS = ['时政与地区', 'tech', 'finance', 'science', '体育与文化'] as const;

export const PRESETS: Preset[] = [
  // ── 时政与地区 ─────────────────────────────────────────────────────────
  p('p-world', 'politics', '国际时政', '我想了解国际政治的重要动态：国家间关系的变化、重大外交事件、冲突与谈判的最新进展。',
    ['外交', '峰会', '联合国', 'diplomacy', 'summit', 'United Nations']),
  p('p-china', 'politics', '中国', '我想了解中国的重要新闻：政策发布、经济数据、社会事件，以及外界对中国的重要报道。',
    ['中国', '北京', '国务院', 'China', 'Beijing', 'Chinese']),
  p('p-us', 'politics', '美国政治', '我想跟进美国政治的重要动态：白宫和国会的决定、重要选举、法院裁决和对外政策。',
    ['美国', '白宫', '国会', '特朗普', 'White House', 'Congress', 'Trump', 'Supreme Court']),
  p('p-europe', 'politics', '欧洲', '我想了解欧洲的重要新闻：欧盟的政策与决定、主要国家的政局变化和选举。',
    ['欧盟', '欧洲', '德国', '法国', 'EU', 'European Union', 'Germany', 'France']),
  p('p-japan-korea', 'politics', '日本与朝鲜半岛', '我想了解日本、韩国和朝鲜的重要动态：政局、经济、外交和安全局势。',
    ['日本', '韩国', '朝鲜', 'Japan', 'South Korea', 'North Korea', 'Tokyo', 'Seoul']),
  p('p-ukraine', 'politics', '俄乌战争', '我想跟进俄乌战争的最新进展：战场局势、停火与和谈、各方援助和制裁。',
    ['乌克兰', '俄罗斯', '泽连斯基', '普京', 'Ukraine', 'Russia', 'Zelensky', 'Putin', 'Kyiv']),
  p('p-mideast', 'politics', '中东', '我想了解中东局势的最新进展：以色列与巴勒斯坦、伊朗、也门和海湾地区的冲突与外交。',
    ['以色列', '加沙', '伊朗', '中东', 'Israel', 'Gaza', 'Iran', 'Middle East', 'Hezbollah']),
  p('p-taiwan', 'politics', '台海', '我想跟进台海局势：两岸关系、台湾政局，以及美国和周边国家的相关动作。',
    ['台湾', '台海', '两岸', 'Taiwan', 'Taipei', 'Taiwan Strait']),
  p('p-south-asia', 'politics', '印度与南亚', '我想了解印度、巴基斯坦等南亚国家的重要政治和经济新闻。',
    ['印度', '巴基斯坦', '莫迪', 'India', 'Pakistan', 'Modi', 'New Delhi']),
  p('p-security', 'politics', '安全与冲突', '我想了解战争、冲突与安全局势的最新进展，包括军事行动、停火谈判和人道状况。',
    ['冲突', '停火', '军事', '袭击', 'conflict', 'ceasefire', 'military', 'attack']),

  // ── 科技 ───────────────────────────────────────────────────────────────
  p('p-tech', 'tech', '科技', '我想看科技行业的重要进展：新产品发布、技术突破、大公司的战略动作和监管变化。',
    ['科技', '科技公司', 'tech', 'technology', 'Apple', 'Google', 'Microsoft']),
  p('p-ai', 'tech', '人工智能', '我想跟进人工智能领域的进展：新模型、研究突破、产品落地、算力与芯片，以及相关的监管和争议。',
    ['人工智能', '大模型', 'AI', 'OpenAI', 'Anthropic', 'artificial intelligence', 'LLM']),
  p('p-chips', 'tech', '半导体芯片', '我想了解半导体行业的重要动态：芯片制造、出口管制、主要公司的产能和技术进展。',
    ['芯片', '半导体', '英伟达', '台积电', 'chip', 'semiconductor', 'Nvidia', 'TSMC']),
  p('p-ev', 'tech', '新能源车', '我想跟进电动车和自动驾驶行业：新车型、销量、电池技术和主要车企的动向。',
    ['电动车', '新能源车', '比亚迪', '特斯拉', 'electric vehicle', 'EV', 'Tesla', 'BYD']),
  p('p-devices', 'tech', '手机与消费电子', '我想看手机、电脑和消费电子的新品发布和重要评测。',
    ['手机', 'iPhone', '华为', '小米', 'smartphone', 'Samsung', 'Pixel']),
  p('p-platforms', 'tech', '互联网平台', '我想了解大型互联网平台的重要变化：产品调整、反垄断和数据隐私监管。',
    ['腾讯', '阿里巴巴', '字节跳动', 'Meta', 'TikTok', 'antitrust']),
  p('p-cyber', 'tech', '网络安全', '我想了解重大网络安全事件：数据泄露、黑客攻击、重要漏洞和相关执法行动。',
    ['网络安全', '黑客', '数据泄露', '漏洞', 'cybersecurity', 'hack', 'breach', 'ransomware']),
  p('p-space', 'tech', '太空探索', '我想跟进航天与太空探索：发射任务、探测器发现和商业航天的进展。',
    ['航天', '火箭', '太空', 'NASA', 'SpaceX', 'rocket', 'spacecraft']),

  // ── 财经 ───────────────────────────────────────────────────────────────
  p('p-economy', 'finance', '财经', '我想看经济和金融的重要消息：央行政策、通胀与就业数据、重大并购、市场剧烈波动背后的原因。',
    ['经济', '央行', '通胀', 'economy', 'central bank', 'inflation']),
  p('p-fed', 'finance', '美联储与利率', '我想跟进美联储和主要央行的利率决定，以及对市场的影响。',
    ['美联储', '利率', '加息', '降息', 'Federal Reserve', 'Fed', 'interest rate']),
  p('p-cn-market', 'finance', 'A 股与港股', '我想了解中国股市和港股的重要行情、监管政策和大公司动态。',
    ['A股', '港股', '恒生指数', '证监会', 'Hang Seng', 'Shanghai Composite']),
  p('p-us-market', 'finance', '美股', '我想看美股市场的重要行情、大公司财报和影响股市的政策。',
    ['美股', '纳斯达克', '标普500', 'Wall Street', 'Nasdaq', 'S&P 500', 'Dow']),
  p('p-crypto', 'finance', '加密货币', '我想了解加密货币行业的重要进展：价格大幅波动、监管政策和主要交易所的动态。',
    ['比特币', '加密货币', '以太坊', 'Bitcoin', 'crypto', 'Ethereum', 'stablecoin']),
  p('p-energy', 'finance', '能源与大宗商品', '我想了解石油、天然气和主要大宗商品的价格变化及其背后的原因。',
    ['石油', '原油', '天然气', '欧佩克', 'oil', 'OPEC', 'natural gas', 'crude']),
  p('p-property', 'finance', '房地产', '我想了解房地产市场的重要变化：房价、政策调整和主要房企的状况。',
    ['房地产', '房价', '楼市', 'property', 'housing', 'real estate']),
  p('p-business', 'finance', '商业', '我想看商业世界的重要变化：公司财报、领导层变动、行业格局转变和重大投资。',
    ['财报', '并购', 'CEO', 'earnings', 'merger', 'acquisition']),

  // ── 科学与健康 ─────────────────────────────────────────────────────────
  p('p-science', 'science', '科学', '我想看科学研究的重要成果：医学、生物、物理、太空探索方面有实质进展的发现。',
    ['研究', '科学家', '发现', 'study', 'scientists', 'research']),
  p('p-medicine', 'science', '医学突破', '我想了解医学领域的重要进展：新药和疗法获批、重要临床试验结果。',
    ['新药', '临床试验', '疗法', 'drug', 'clinical trial', 'FDA', 'treatment']),
  p('p-public-health', 'science', '公共卫生', '我想跟进公共卫生事件：传染病疫情、疫苗和世卫组织的重要通报。',
    ['疫情', '疫苗', '世卫组织', 'outbreak', 'vaccine', 'WHO', 'virus']),
  p('p-climate', 'science', '气候环境', '我想关注气候与环境议题：极端天气事件、能源转型、环境政策和相关的科学研究。',
    ['气候', '极端天气', '碳排放', 'climate', 'heatwave', 'emissions', 'wildfire']),
  p('p-disaster', 'science', '自然灾害', '我想及时知道重大自然灾害：地震、台风、洪水及救援情况。',
    ['地震', '台风', '洪水', 'earthquake', 'typhoon', 'hurricane', 'flood']),

  // ── 体育与文化 ─────────────────────────────────────────────────────────
  p('p-football', 'culture', '足球', '我想看足球的重要赛果和新闻：主要联赛、欧冠、世界杯和转会。',
    ['足球', '英超', '欧冠', '世界杯', 'football', 'Premier League', 'Champions League', 'World Cup']),
  p('p-basketball', 'culture', '篮球', '我想看篮球的重要赛果和新闻：NBA 和中国篮球。',
    ['NBA', '篮球', 'CBA', 'basketball']),
  p('p-sports', 'culture', '综合体育', '我想了解重大体育赛事和新闻：奥运、网球大满贯、F1 等。',
    ['奥运', '网球', 'F1', 'Olympics', 'Grand Slam', 'Formula 1']),
  p('p-culture', 'culture', '文化', '我想看文化领域值得一读的内容：影视、音乐、出版、艺术方面的重要作品和现象。',
    ['电影', '音乐', '出版', 'film', 'music', 'book']),
  p('p-film', 'culture', '电影与剧集', '我想了解电影和剧集的重要新闻：新片上映、票房、奖项和行业动态。',
    ['电影', '票房', '奥斯卡', '剧集', 'box office', 'Oscars', 'Netflix']),
  p('p-games', 'culture', '游戏', '我想了解游戏行业的重要新闻：新作发布、主要厂商动态和行业变化。',
    ['游戏', '任天堂', '索尼', 'game', 'Nintendo', 'PlayStation', 'Xbox'])
];

/**
 * The same topics for an English interface. The sentence is what the judge
 * reads, so a preset added in English is a watch written in English; its
 * keywords are already bilingual.
 */
const EN: Record<string, [label: string, intent: string]> = {
  'p-world': ['World politics', 'I want the important moves in international politics: shifting relations between countries, major diplomatic events, and the latest on conflicts and negotiations.'],
  'p-china': ['China', 'I want the important news from China: policy announcements, economic data, social events, and major outside reporting on China.'],
  'p-us': ['US politics', 'I want to follow US politics: decisions by the White House and Congress, major elections, court rulings and foreign policy.'],
  'p-europe': ['Europe', 'I want the important news from Europe: EU policies and decisions, and changes of government and elections in the major countries.'],
  'p-japan-korea': ['Japan and the Korean Peninsula', 'I want the important developments in Japan, South Korea and North Korea: politics, economy, diplomacy and security.'],
  'p-ukraine': ['Russia–Ukraine war', 'I want to follow the latest in the Russia–Ukraine war: the battlefield, ceasefire and peace talks, aid and sanctions.'],
  'p-mideast': ['Middle East', 'I want the latest on the Middle East: Israel and Palestine, Iran, Yemen and the Gulf — conflicts and diplomacy.'],
  'p-taiwan': ['Taiwan Strait', 'I want to follow the Taiwan Strait: cross-strait relations, Taiwanese politics, and what the US and neighbouring countries do about it.'],
  'p-south-asia': ['India and South Asia', 'I want the important political and economic news from India, Pakistan and the rest of South Asia.'],
  'p-security': ['Security and conflict', 'I want the latest on wars, conflicts and security: military operations, ceasefire talks and the humanitarian situation.'],
  'p-tech': ['Technology', 'I want the important progress in the tech industry: product launches, breakthroughs, big companies\' strategic moves and regulation.'],
  'p-ai': ['Artificial intelligence', 'I want to follow AI: new models, research breakthroughs, products, compute and chips, and the regulation and controversy around them.'],
  'p-chips': ['Semiconductors', 'I want the important news in semiconductors: chipmaking, export controls, and the capacity and technology of the major companies.'],
  'p-ev': ['Electric vehicles', 'I want to follow electric vehicles and self-driving: new models, sales, battery technology and what the major carmakers are doing.'],
  'p-devices': ['Phones and gadgets', 'I want launches and major reviews of phones, computers and consumer electronics.'],
  'p-platforms': ['Internet platforms', 'I want the important changes at the big internet platforms: product shifts, antitrust and data-privacy regulation.'],
  'p-cyber': ['Cybersecurity', 'I want major cybersecurity events: data breaches, hacks, serious vulnerabilities and the law-enforcement actions that follow.'],
  'p-space': ['Space', 'I want to follow spaceflight and exploration: launches, discoveries by probes and progress in commercial space.'],
  'p-economy': ['Economy', 'I want the important economic and financial news: central-bank policy, inflation and jobs data, major deals, and why markets move sharply.'],
  'p-fed': ['The Fed and interest rates', 'I want to follow rate decisions by the Federal Reserve and other major central banks, and their effect on markets.'],
  'p-cn-market': ['China and Hong Kong stocks', 'I want the important moves in mainland Chinese and Hong Kong stocks, regulation, and news from the big listed companies.'],
  'p-us-market': ['US stocks', 'I want the important moves in US stocks, big-company earnings, and policies that move the market.'],
  'p-crypto': ['Crypto', 'I want the important news in crypto: big price swings, regulation and what the major exchanges are doing.'],
  'p-energy': ['Energy and commodities', 'I want to know how oil, gas and the major commodities are moving, and why.'],
  'p-property': ['Property', 'I want the important changes in property markets: prices, policy changes and the state of the major developers.'],
  'p-business': ['Business', 'I want the important changes in business: earnings, leadership changes, shifts in industries and major investments.'],
  'p-science': ['Science', 'I want important scientific results: discoveries in medicine, biology, physics and space that are real progress.'],
  'p-medicine': ['Medical breakthroughs', 'I want the important progress in medicine: new drugs and treatments approved, and major clinical-trial results.'],
  'p-public-health': ['Public health', 'I want to follow public-health events: outbreaks, vaccines and important notices from the WHO.'],
  'p-climate': ['Climate and environment', 'I want climate and environment: extreme weather, the energy transition, environmental policy and the science behind them.'],
  'p-disaster': ['Natural disasters', 'I want to know promptly about major natural disasters — earthquakes, typhoons, floods — and the rescue efforts.'],
  'p-football': ['Football', 'I want the important football results and news: the major leagues, the Champions League, the World Cup and transfers.'],
  'p-basketball': ['Basketball', 'I want the important basketball results and news: the NBA and Chinese basketball.'],
  'p-sports': ['Sport', 'I want the major sporting events and news: the Olympics, tennis Grand Slams, F1 and more.'],
  'p-culture': ['Culture', 'I want what is worth reading in culture: important works and trends in film, music, publishing and art.'],
  'p-film': ['Film and TV', 'I want the important film and TV news: releases, box office, awards and the industry.'],
  'p-games': ['Games', 'I want the important games-industry news: new releases, the major studios and platforms, and how the industry is changing.']
};

/** A preset in the interface language: English for `en*`, otherwise Chinese. */
export function localisePreset(preset: Preset, lang?: string): Preset {
  const en = lang?.startsWith('en') ? EN[preset.id] : undefined;
  return en ? { ...preset, label: en[0], intent: en[1] } : preset;
}

/** Creates a watch from a preset, in the interface language. Idempotent. */
export function enablePreset(db: Db, presetId: string, lang?: string): string | null {
  const found = PRESETS.find((x) => x.id === presetId);
  if (!found) return null;
  const existing = listWatches(db).find((w) => w.id === found.id);
  if (existing) return existing.id;
  const preset = localisePreset(found, lang);
  return createWatch(db, { id: preset.id, origin: 'preset', label: preset.label, intent: preset.intent, keywords: preset.keywords }).id;
}
