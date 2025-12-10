export interface Option {
  label: string;
  value: string;
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