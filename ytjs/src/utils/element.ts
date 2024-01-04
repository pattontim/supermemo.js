export class ElementInfoV1 {
  version: number;
  supermemoTarget: string;
  templateId: string;

  constructor(supermemoTarget: string, elementId: string) {
    this.version = 1;
    this.supermemoTarget = supermemoTarget;
    this.templateId = elementId;
  }
}

export type ElementInfo = ElementInfoV1 // | ElementInfoV2
