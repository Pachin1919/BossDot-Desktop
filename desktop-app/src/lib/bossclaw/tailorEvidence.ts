import type { TailorResumeDoc } from './jobAssistant';

export interface TailorEvidenceFinding {
  field: string;
  text: string;
  source?: { material: string; line: number; quote: string };
  issue?: string;
}

const normalize = (text: string) =>
  text.normalize('NFKC').replace(/\*\*/g, '').replace(/[‐‑–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

function containsFact(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const end = at + needle.length;
    const partOfLargerNumber = (/^\d/.test(needle) && /\d/.test(haystack[at - 1] ?? ''))
      || (/\d$/.test(needle) && /\d/.test(haystack[end] ?? ''));
    if (!partOfLargerNumber) return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

export function validateTailorEvidence(doc: TailorResumeDoc, resumeText: string, extraMaterials = ''): TailorEvidenceFinding[] {
  const materials = [{ name: '简历原文', text: resumeText }];
  const parts = extraMaterials.split(/^【补充材料：([^\r\n】]+)】\r?\n/gm);
  if (parts[0]?.trim()) materials.push({ name: '补充材料', text: parts[0] });
  for (let index = 1; index < parts.length; index += 2) {
    materials.push({ name: parts[index], text: parts[index + 1] });
  }
  const lines = materials.flatMap(({ name, text }) => text.split(/\r?\n/).map((line, index) => {
    const quote = line.trim();
    const excerpt = /^[-*]?\s*原文(?:[（(][^）)]+[）)])?\s*[：:]\s*“(.+)”$/.exec(quote)?.[1];
    return { material: name, line: index + 1, quote, normalized: normalize(excerpt || quote) };
  }));

  const findings: TailorEvidenceFinding[] = [];
  const check = (field: string, text: string, quote = text, candidates = lines) => {
    if (!text.trim()) return;
    const wanted = normalize(quote);
    const claimed = normalize(text);
    const isContent = field.includes('.bullets.') || /^(skills\.|selfEval$)/.test(field);
    const wholeClause = (original: string, excerpt: string) =>
      original === excerpt || original.split(/[；;。]/).map((part) => part.trim()).includes(excerpt);
    const exactQuote = candidates.filter((item) => containsFact(item.normalized, wanted));
    const match = exactQuote.find((item) => !isContent || wholeClause(item.normalized.replace(/^[-*•]\s+/, ''), wanted));
    if (!match || claimed !== wanted) {
      findings.push({
        field,
        text,
        issue: !wanted ? '缺少原文摘录' : !exactQuote.length ? '摘录不在原始材料中' : '摘录未覆盖完整表述',
      });
      return;
    }
    findings.push({ field, text, source: { material: match.material, line: match.line, quote: quote.trim() } });
    return match;
  };

  for (const section of ['education', 'internships', 'works', 'projects'] as const) {
    for (const [index, block] of doc[section].entries()) {
      const field = `${section}.${index}`;
      const normalizedHeading = normalize(block.heading);
      const headings = lines.filter((item) => containsFact(item.normalized, normalizedHeading));
      const match = check(`${field}.heading`, block.heading, block.heading, headings);
      if (!match) {
        if (!normalizedHeading) findings.push({ field: `${field}.heading`, text: '', issue: '经历缺少可核对的标题' });
      } else {
        const explicitlyInternship = /实习|\bintern(?:ship)?\b/i;
        const explicitlyProject = /项目制|\bproject-based\b/i;
        const explicitlyEmployment = /正式工作|正式任职|全职|\bfull[- ]time\b/i;
        const categoryMatches = (source: string) => section === 'internships'
          ? !explicitlyProject.test(source) && !explicitlyEmployment.test(source)
          : section === 'works'
            ? !explicitlyInternship.test(source) && !explicitlyProject.test(source)
            : section === 'projects'
              ? !explicitlyInternship.test(source) && !explicitlyEmployment.test(source)
              : true;
        const eligible = headings.filter((item) => categoryMatches(item.quote));
        if (!eligible.length) {
          findings.push({ field, text: block.heading, issue: '归类与原文标注的经历性质冲突' });
        }
        if (block.meta) check(`${field}.meta`, block.meta, block.meta, eligible);
      }
      block.bullets.forEach((bullet, index) => check(`${field}.bullets.${index}`, bullet.text, bullet.source));
    }
  }
  doc.skills.forEach((line, index) => check(`skills.${index}`, line.text, line.source));
  doc.honors.forEach((line, index) => check(`honors.${index}`, line));
  check('selfEval', doc.selfEval.text, doc.selfEval.source);
  return findings;
}
