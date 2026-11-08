export interface Clock {
  now(): Date;
  isoNow(): string;
}
