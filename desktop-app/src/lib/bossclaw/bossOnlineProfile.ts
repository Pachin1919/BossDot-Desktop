export const BOSS_ONLINE_RESUME_URL = 'https://www.zhipin.com/web/geek/resume';

export interface BossOnlineIntent {
  jobTitle: string;
  employmentType: string | null;
  salary: string;
  cities: string[];
}

export interface BossOnlineProfile {
  sourceUrl: string;
  capturedAt: string;
  intents: BossOnlineIntent[];
  unparsedIntents: string[];
  workExperience: string;
  projectExperience: string;
}

export type BossOnlineProfileResult =
  | { ok: true; profile: BossOnlineProfile }
  | { ok: false; error: string };

const INTENT_HEADING = /^(期望职位|求职意向|求职期望)$/;
const SECTION_HEADING = /^(工作经历|实习经历|项目经历|教育经历|在校经历|资格证书|培训经历|专业技能|社交主页|附加信息|自我评价)$/;
const EMPLOYMENT_HEADING = /^(全职|实习|兼职)(?:职位|岗位)?$/;
const EDITING_LABEL = /^(?:添加(?:期望职位|求职意向|工作经历|项目经历)?|新增(?:期望职位|求职意向)?|编辑|删除|展开|收起)$/;
const SALARY = /(?:(?:\d+(?:\.\d+)?\s*[-–—~至]\s*)?\d+(?:\.\d+)?\s*(?:k|千元?|万元?|元)(?:\s*(?:·\s*\d+薪|以上))?|薪资面议|薪资不限|面议)/i;

export function isBossOnlineResumeUrl(url: string): boolean {
  return /^https:\/\/www\.zhipin\.com\/web\/geek\/resume(?:\/?[?#]|\/?$)/.test(url);
}

/** 只提取简历正文的求职意向、工作经历和项目经历。 */
export function parseBossOnlineProfile(bodyText: string): Omit<BossOnlineProfile, 'sourceUrl' | 'capturedAt'> | null {
  const lines = bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let intentStart = -1;
  for (const [index, line] of lines.entries()) {
    if (INTENT_HEADING.test(line)) intentStart = index;
  }
  if (intentStart < 0) return null;

  const nextSection = lines.findIndex((line, index) => index > intentStart && SECTION_HEADING.test(line));
  if (nextSection < 0) return null;
  const intentLines = lines.slice(intentStart + 1, nextSection);
  const intents: BossOnlineIntent[] = [];
  const unparsedIntents: string[] = [];
  let employmentType: string | null = null;
  for (const line of intentLines) {
    if (EDITING_LABEL.test(line)) continue;
    const heading = EMPLOYMENT_HEADING.exec(line);
    if (heading) {
      employmentType = heading[1];
      continue;
    }
    const match = SALARY.exec(line);
    const jobTitle = match ? line.slice(0, match.index).trim() : '';
    if (!match || !jobTitle) {
      unparsedIntents.push(line);
      continue;
    }
    intents.push({
      jobTitle,
      employmentType,
      salary: match[0].replace(/\s+/g, ''),
      cities: line.slice(match.index + match[0].length).split(/[\s，,、；;]+/).filter(Boolean),
    });
  }

  const experience = (name: string) => {
    const start = lines.findIndex((line, index) => index > intentStart && line === name);
    if (start < 0) return '';
    const end = lines.findIndex((line, index) => index > start && SECTION_HEADING.test(line));
    return lines.slice(start + 1, end === -1 ? undefined : end)
      .filter((line) => !EDITING_LABEL.test(line))
      .join('\n');
  };
  const workExperience = experience('工作经历');
  const projectExperience = experience('项目经历');
  if (!intents.length && !unparsedIntents.length && !workExperience && !projectExperience && !intentLines.some((line) => EDITING_LABEL.test(line))) {
    return null;
  }
  return { intents, unparsedIntents, workExperience, projectExperience };
}
