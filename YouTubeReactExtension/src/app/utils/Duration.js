  function convertHHMMSS2Duration(hhmmss) {
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

  function convertDuration2HHMMSS(duration) {
    var sec_num = parseInt(duration, 10); // don't forget the second param
    var hours   = Math.floor(sec_num / 3600);
    var minutes = Math.floor((sec_num - (hours * 3600)) / 60);
    var seconds = sec_num - (hours * 3600) - (minutes * 60);

    if (hours   < 10) {hours   = "0"+hours;}
    if (minutes < 10) {minutes = "0"+minutes;}
    if (seconds < 10) {seconds = "0"+seconds;}
    return hours + ':' + minutes + ':' + seconds;
  }

  function constrainToRange(value, min, max) {
    if (value < min) {
        return min;
    } else if (value > max) {
        return max;
    } else {
        return value;
    }
  }

export { convertHHMMSS2Duration, convertDuration2HHMMSS, constrainToRange };