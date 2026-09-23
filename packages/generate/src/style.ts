/**
 * How AI-written news reads, shared by every writing prompt (快讯, 今日摘要, 进展).
 *
 * Written from English material, Chinese output drifts into translated syntax:
 * stacked modifiers, weekday names without a date, the same fact said twice,
 * rubric words such as「属于重大进展」. A reader notices at once, so these are
 * the rules a Chinese news desk would give. Ported in spirit from daily-brief's
 * STORY_NEWS_VOICE_LINES (lib/prompts/news/editorial-rules.ts).
 */
export function writingRules(lang: string): string[] {
  if (lang.startsWith('zh')) return [
    'WRITING（写给人读的新闻，不是翻译稿）',
    '- 按中文新闻的习惯写：短句，主语在前，一句只说一件事。外文材料先读懂，再用中文重新写，不要逐句翻译。',
    '- 不堆长定语，不把一长串内容塞进「就……达成」「对……的……方案」这类结构里。先用短句说谁做了什么，再用下一句补细节。',
    '  例：不写「市政府未能就调整地铁票价以弥补运营亏损的方案达成一致」，写「市政府没能就地铁票价达成一致。分歧在于要不要涨价来弥补运营亏损。」',
    '- 同一个事实只说一遍，不要换个说法再说一次。',
    '- 不写「周一」「昨天」「本周」这类相对时间。能从材料的发布时间推出日期的，写成「21日」或「9月21日」；推不出就不写。',
    '- 外国人名、机构名用通行的中文译名；读者不熟悉的，用几个字交代身份，如「俄罗斯商人」「伊朗外长」。',
    '- 不用套话和模板连接词：此次、进一步、凸显、标志着、释放信号、在……背景下、值得注意的是、据悉。',
    '- 不下评级式结论，如「属于重大外交突破」「具有重要意义」；直接写发生了什么、影响到谁。'
  ];
  return [
    'WRITING (news for a person to read, not a translation)',
    '- Plain news prose: short sentences, subject first, one fact per sentence. Read foreign-language material, then write it fresh; do not translate sentence by sentence.',
    '- Say each fact once.',
    '- No bare weekdays or "yesterday": write the date ("Sept. 21") when the material\'s publication time allows it, otherwise leave the time out.',
    '- Give unfamiliar people and bodies a few words of identity ("Russian businessman", "Iran\'s foreign minister").',
    '- No template phrases: underscores, highlights, signals, amid, marks a turning point, notably.',
    '- No verdict labels ("a major diplomatic breakthrough"); state what happened and who it affects.'
  ];
}
