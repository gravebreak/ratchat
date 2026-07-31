export type WeightedCandidates<CandidateType> = Map<CandidateType, Weight>;
export type UniformCandidates<CandidateType> = CandidateType[];
export type GaussianCandidate<CandidateType> = {candidate: CandidateType, baseline: Baseline};

export type Weight = number;
export type Baseline = number;
