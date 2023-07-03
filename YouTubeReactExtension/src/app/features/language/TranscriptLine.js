import React, { useState } from 'react';

export default function TranscriptLine({ cue, seek, query }) {
  const [isActive, setIsActive] = useState(false);

  const style = query && cue && cue.text.match(new RegExp(query, 'i')) ? 'match' : isActive ? 'active' : '';

	if(cue){
    cue.onenter = () => { setIsActive(true); };
    cue.onexit = () => { setIsActive(false); };
    // this.onClick = this.onClick.bind(this) TODO
	}

  const handleClick = () => {
	if (!cue) return;
    seek(startTime())
  }

  const startTime = () => {
	if (!cue) return;
    return formatSeconds(cue.startTime);
  }

  const endTime = () => {
	if (!cue) return;
    return formatSeconds(cue.endTime);
  }

  // TODO HH support or use utils
  const formatSeconds = (t) => {
    let mins = Math.floor(t / 60)
    if (mins < 10) {
      mins = `0${mins}`
    }

    let secs = Math.floor(t % 60)
    if (secs < 10) {
      secs = `0${secs}`
    }

    return `${mins}:${secs}`
  }

	// note: dangerouslySetInnerHTML is used because the text may contain HTML
	return (
		<div className={`${style} line`} onClick={handleClick}>
			<div className="time">
				[{startTime()} - {endTime()}]
			</div>
			<div
				className={`${style} text`}
				dangerouslySetInnerHTML={{ __html: cue ? cue.text : "" }} 
        />
		</div>
	)

}