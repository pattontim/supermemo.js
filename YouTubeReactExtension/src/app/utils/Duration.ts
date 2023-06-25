  export function convertHHMMSS2Seconds(hhmmss: string | null) {
    if (hhmmss === null) {
      return 0;
    }
    var a = hhmmss.split(':'); // split it at the colons
    var seconds = 0;
    
    if (a.length === 2) {
      // Format: M:SS
      seconds = (+a[0]) * 60 + (+a[1]);
    } else if (a.length === 3) {
      // Format: H:MM:SS
      seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);
    } else {
      // Invalid format
      return 0;
    }
    
    return seconds;
  }

  export function convertSeconds2HHMMSS(duration: number | string) {
    var sec_num = typeof(duration) == "number" ? Math.floor(duration) : parseInt(duration as string, 10);
    var hours: string | number = Math.floor(sec_num / 3600);
    var minutes: string | number = Math.floor((sec_num - (hours as number * 3600)) / 60);
    var seconds: string | number = sec_num - (hours as number * 3600) - (minutes as number * 60);

    if (hours < 10) { hours = "0" + hours; }
    if (minutes < 10) { minutes = "0" + minutes; }
    if (seconds < 10) { seconds = "0" + seconds; }
    return hours + ':' + minutes + ':' + seconds;
  }

  export function constrainToRange(value: number, min: number, max: number) {
    if (value < min) {
        return min;
    } else if (value > max) {
        return max;
    } else {
        return value;
    }
  }

  export const formatTime = (seconds: number, limitDurationSec: number) => {
    return convertSeconds2HHMMSS(constrainToRange(seconds, 0, limitDurationSec)).replace(/^0{0,3}:/, '');
  }

  export const formatTimestamp = (timeStamp: string, limitDurationSec: number) => {
    return convertSeconds2HHMMSS(constrainToRange(convertHHMMSS2Seconds(timeStamp), 0, limitDurationSec)).replace(/^0{0,3}:/, '');
  }
