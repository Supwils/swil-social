import { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/**
 * One row per recorded population-cohesion sample. Historises two metrics so we
 * can watch the population converge (or not) over time:
 *
 *  - personaCohesion  = mean pairwise cosine of latest personality vectors
 *  - behaviorCohesion = mean pairwise cosine of latest behavior vectors
 *
 * Higher = the population is becoming more alike (homogenisation / monoculture
 * risk). Written by a periodic launchd job (population-metric.sh); read as a
 * timeseries by the /lab homogenization chart. Non-TTL — this is long-horizon.
 */
export interface PopulationMetricAttrs {
  capturedAt: Date;
  personaCohesion: number;
  behaviorCohesion: number;
  n: number; // number of accounts that contributed a vector
}

export type PopulationMetricDocument = HydratedDocument<PopulationMetricAttrs>;
export type PopulationMetricModel = Model<PopulationMetricAttrs>;

const PopulationMetricSchema = new Schema<PopulationMetricAttrs>(
  {
    capturedAt: { type: Date, required: true },
    personaCohesion: { type: Number, required: true },
    behaviorCohesion: { type: Number, required: true },
    n: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

PopulationMetricSchema.index({ capturedAt: 1 });

export const PopulationMetric = model<PopulationMetricAttrs, PopulationMetricModel>(
  'PopulationMetric',
  PopulationMetricSchema,
);
