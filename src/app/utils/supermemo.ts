export interface Option {
  label: string;
  value: string;
}

export interface Session {
  resume: string | null;
  start: string | null;
  stop: string | null;
  played: number;
  options: Option[];
}

// Encoding options to search params
export const encodeOptionsToSearchParam = (options: Option[]): string => {
  return encodeURIComponent(JSON.stringify(options));
};

// Decoding options from search params
export const decodeOptionsFromSearchParam = (searchParam: string | null): Option[] => {
  if (!searchParam) return [];
  try {
    const decoded = decodeURIComponent(searchParam);
    return JSON.parse(decoded) as Option[];
  } catch (e) {
    console.error("Failed to decode options", e);
    return [];
  }
};

// Encoding session to search params
export const encodeSessionToSearchParam = (session: Session): string => {
  return encodeURIComponent(JSON.stringify(session));
};

// Decoding session from search params
export const decodeSessionFromSearchParam = (searchParam: string | null): Session | null => {
  if (!searchParam) return null;
  try {
    const decoded = decodeURIComponent(searchParam);
    return JSON.parse(decoded) as Session;
  } catch (e) {
    console.error("Failed to decode session", e);
    return null;
  }
};

function isValidInput(elem: HTMLElement | null): elem is HTMLInputElement {
    return elem != null && elem instanceof HTMLInputElement && elem.value != null;
}

function buildUrlString(url: URL) {
    const vid = document.getElementById("videoid") as HTMLInputElement;
    const res = document.getElementById("resumevideoat") as HTMLInputElement;
    const start = document.getElementById("startvideoat") as HTMLInputElement;
    const stop = document.getElementById("stopvideoat") as HTMLInputElement;
    
    if(    !isValidInput(vid)
        || !isValidInput(res)
        || !isValidInput(start)
        || !isValidInput(stop)  ) {
        throw new Error("Invalid supermemo inputs");
    }

    var urlString = "",
        oTs = new Date(),
        sTs = [
            oTs.getFullYear(),
            oTs.getMonth(),
            oTs.getDate(),
            oTs.getHours(),
            oTs.getMinutes(),
            oTs.getSeconds(),
            oTs.getMilliseconds()
        ].join("");

    urlString += "videoid=" + vid.value + "&";
    urlString += "resume=" + res.value + "&";
    urlString += "start=" + start.value + "&";
    urlString += "stop=" + stop.value + "&";
    urlString += "ts=" + sTs;

    return urlString;
}