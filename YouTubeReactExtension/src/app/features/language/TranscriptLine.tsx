import React, { useState } from 'react';

interface TranscriptLineProps<T> {
    cue: TextTrackCue;
    seek: (time: string) => void;
    query: null;
}

export default function TranscriptLine<T extends unknown>({ cue, 
  seek, query }: TranscriptLineProps<T>) {
  const [isActive, setIsActive] = useState(false);

  // TODO check that this changes
  const style = query && cue && (cue as VTTCue).text.match(new RegExp(query, 'i')) ? 'match' : isActive ? 'active' : '';

	if(cue){
    cue.onenter = () => { setIsActive(true); };
    cue.onexit = () => { setIsActive(false); };
    // this.onClick = this.onClick.bind(this) TODO
	}

  const handleClick = () => {
    if (!cue) return;
    const startTimeString = startTime();
    if (!startTimeString) return;
    seek(startTimeString as string);
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
  const formatSeconds = (t: number) => {
    let mins = Math.floor(t / 60)
    let secs = Math.floor(t % 60)

    return `${mins < 10 ? `0${mins}`
     : mins}:${secs < 10 ? `0${secs}` : secs}`
  }

	// note: dangerouslySetInnerHTML is used because the text may contain HTML
	return (
		<div className={`${style} line`} onClick={handleClick}>
			<div className="time">
				[{startTime()} - {endTime()}]
			</div>
			<div
				className={`${style} text`}
				dangerouslySetInnerHTML={{ __html: cue ? (cue as VTTCue).text : "" }} 
        />
		</div>
	)

}