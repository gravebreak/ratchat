export type InputStatus = boolean & {readonly __brand: 'Input'};

export const clearInput: InputStatus = true as InputStatus;
export const keepInput: InputStatus = false as InputStatus;
