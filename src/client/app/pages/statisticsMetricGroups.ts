import type {
  StatisticsComparableValue,
  StatisticsResponse,
} from "../../../shared/types/api";

type Row = {
  label: string;
  value: StatisticsComparableValue;
  percent?: boolean;
  detail?: string;
};
type Group = { name: string; rows: Row[] };
type Metrics = StatisticsResponse["metrics"];

const audienceAndJoinGroups = (metrics: Metrics): Group[] => [
  {
    name: "Traffic",
    rows: [
      {
        label: "App impressions",
        value: metrics.traffic.impressions,
        detail: "Successful app initializations",
      },
      {
        label: "Viewing sessions",
        value: metrics.traffic.viewingSessions,
        detail: "One viewing session per visitor, post, and UTC hour",
      },
    ],
  },
  {
    name: "Visitors",
    rows: [
      { label: "Unique visitors", value: metrics.visitors.unique },
      {
        label: "Returning visitors",
        value: metrics.visitors.returning,
      },
      {
        label: "Returning rate",
        value: metrics.visitors.returningRate,
        percent: true,
      },
    ],
  },
  {
    name: "Membership",
    rows: [
      {
        label: "App-tracked subscribed sessions",
        value: metrics.membership.appTrackedSubscribedSessions,
      },
      {
        label: "Join-eligible sessions",
        value: metrics.membership.joinEligibleSessions,
        detail: "Not verified Reddit non-membership",
      },
    ],
  },
  {
    name: "Join Performance",
    rows: [
      { label: "Join clicks", value: metrics.joins.clicks },
      {
        label: "Unique Join-click sessions",
        value: metrics.joins.uniqueClickSessions,
      },
      { label: "Confirmed joins", value: metrics.joins.confirmed },
      {
        label: "Join click success rate",
        value: metrics.joins.clickSuccessRate,
        percent: true,
        detail: "Confirmed joins / Join clicks",
      },
      {
        label: "Join CTR",
        value: metrics.joins.ctr,
        percent: true,
        detail: "Unique click sessions / eligible sessions",
      },
    ],
  },
];

const interactionGroups = (metrics: Metrics): Group[] => [
  {
    name: "Secondary CTAs",
    rows: [
      { label: "CTA clicks", value: metrics.ctas.clicks },
      {
        label: "Unique CTA-click sessions",
        value: metrics.ctas.uniqueClickSessions,
      },
      {
        label: "Eligible CTA sessions",
        value: metrics.ctas.eligibleSessions,
      },
      {
        label: "Secondary CTA CTR",
        value: metrics.ctas.ctr,
        percent: true,
        detail: "Unique click sessions / eligible sessions",
      },
      ...metrics.ctas.byLabel.flatMap((cta) => [
        { label: `${cta.label} — clicks`, value: cta.clicks },
        {
          label: `${cta.label} — unique sessions`,
          value: cta.uniqueSessions,
        },
      ]),
    ],
  },
  {
    name: "CTA-only Performance",
    rows: [
      { label: "CTA-only clicks", value: metrics.ctaOnly.clicks },
      {
        label: "Unique CTA-only click sessions",
        value: metrics.ctaOnly.uniqueClickSessions,
      },
      {
        label: "Eligible CTA-only sessions",
        value: metrics.ctaOnly.eligibleSessions,
      },
      {
        label: "CTA-only CTR",
        value: metrics.ctaOnly.ctr,
        percent: true,
      },
    ],
  },
  {
    name: "Overall",
    rows: [
      {
        label: "Interacting sessions",
        value: metrics.interactions.uniqueSessions,
      },
      {
        label: "Eligible interaction sessions",
        value: metrics.interactions.eligibleSessions,
      },
      {
        label: "Overall interaction CTR",
        value: metrics.interactions.ctr,
        percent: true,
        detail: "Unique interacting sessions / eligible sessions",
      },
    ],
  },
];

export const getStatisticsMetricGroups = (metrics: Metrics): Group[] => [
  ...audienceAndJoinGroups(metrics),
  ...interactionGroups(metrics),
];
