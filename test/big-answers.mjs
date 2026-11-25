const day = (i) => new Date(Date.UTC(2013, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const series = (n, value) => Array.from({ length: n }, (_, i) => ({ date: day(i * 2), value: value(i) }));
const company = (i) => ({
  name: `Example Unit ${i}`,
  slug: { linkedin: `example-unit-${i}`, twitter: null, facebook: null, crunchbase: null },
  industries: [{ id: 4, value: "Software Development", primary: true }],
  location: { country: null, countryIso3: null, city: null, state: null, rawLocationString: "Seattle, WA", coordinates: null, type: null },
  url: `https://www.linkedin.com/company/example-unit-${i}`,
  relationship: i % 3 === 0 ? "subsidiary" : null,
});

export function bigCompany({ points = 1500, affiliates = 60, locations = 45 } = {}) {
  return {
    summary: { name: "Example Corp", logo: null, tagline: null, industry: "Software Development", employeeCount: 120000, websiteUrl: "https://example.com" },
    name: "Example Corp",
    tagline: null,
    description: "Example Corp builds example software for example people. ".repeat(20),
    foundedYear: null,
    specialties: ["Examples", "Software", "Cloud"],
    slug: { linkedin: "example-corp", twitter: null, facebook: null, crunchbase: null },
    industries: [{ id: 4, value: "Software Development", primary: true }],
    location: { country: "US", city: "Redmond", state: "WA", postalCode: null, line1: "1 Example Way", type: "hq" },
    locations: Array.from({ length: locations }, (_, i) => ({ country: "US", city: `City ${i}`, state: null, line1: `${i} Example Street`, rawLocationString: `${i} Example Street, City ${i}, US`, coordinates: null, type: i === 0 ? "hq" : null })),
    companySize: {
      range: [10001, null],
      linkedinCode: "I",
      employeeCountOnLinkedin: 120000,
      employeeCountOverTime: series(points, (i) => 100000 + i * 13),
      organizationSizeOverTime: series(points, () => "10,001+ employees"),
    },
    headcountGrowthMetrics: { quarterlyGrowthRate: 0.01, annualGrowthRate: 0.04, trend: "growing", velocity: null, lastComputedAt: "2026-11-21" },
    contactInformation: { emails: [], phoneNumbers: [], socialLinks: { linkedinUrl: "https://www.linkedin.com/company/example-corp", crunchbaseUrl: null } },
    socialPresence: { followers: { total: 5000000, linkedin: 5000000 }, followerCountOverTime: series(points, (i) => 4000000 + i * 701) },
    linkedinJobs: { totalOverTime: [] },
    similarCompanies: Array.from({ length: 12 }, (_, i) => company(100 + i)),
    affiliatedCompanies: Array.from({ length: affiliates }, (_, i) => company(i)),
    funding: { summary: { crunchbaseUrl: null, roundsCount: null }, rounds: [], roundsCountOverTime: [] },
    stock: { exchange: null, tickerSymbol: null },
    acquisitions: { acquired: [], acquiredBy: null },
    exits: [],
    activities: { posts: [] },
    meta: { updatedAt: "2026-11-21T00:00:00.000Z" },
  };
}

export function bigPerson({ roles = 33, posts = 100, related = 40, slug = "jane-example" } = {}) {
  return {
    summary: { fullName: "Jane Example", jobTitle: "Founder", currentCompanies: ["Example Corp"] },
    slug: { linkedin: slug, github: null, facebook: null, twitter: null },
    fullName: "Jane Example",
    middleName: null,
    headline: "Founder at Example Corp",
    about: "Builds example companies. ".repeat(30),
    experience: {
      work: Array.from({ length: roles }, (_, i) => ({
        title: `Role ${i}`,
        company: `Example ${i}`,
        companyInfo: { linkedin: `example-${i}`, facebook: null, twitter: null },
        startDate: { year: 2026 - i },
        endDate: i === 0 ? null : { year: 2027 - i },
        description: `Led the example work number ${i}. `.repeat(20),
        location: null,
      })),
      volunteer: [],
    },
    education: Array.from({ length: 4 }, (_, i) => ({ school: `Example University ${i}`, degree: "BSc", activities: null })),
    contactInformation: { emails: { personal: [], work: [] }, phoneNumbers: [], socialLinks: null },
    activities: {
      posts: Array.from({ length: posts }, (_, i) => ({ title: `Post ${i}: ${"an example thought ".repeat(10)}`, url: `https://www.linkedin.com/feed/update/urn:li:activity:${1000 + i}`, publishedDate: day(4000 - i), likes: i, comments: 0 })),
    },
    relatedProfiles: Array.from({ length: related }, (_, i) => ({ name: `Person ${i}`, url: `https://www.linkedin.com/in/person-${i}`, location: "" })),
    careerInsight: null,
    developerProfile: null,
    meta: { updatedAt: "2026-11-23T00:00:00.000Z", experienceRestrictedOn: null },
  };
}
