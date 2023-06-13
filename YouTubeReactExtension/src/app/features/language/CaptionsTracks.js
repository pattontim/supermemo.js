import React, { useEffect, useState } from 'react'

export default function CaptionsTracks({ url }) {
    const [captions, setCaptions] = useState([]);

    useEffect(() => {
        console.log("hello from CaptionsTracks");
    }, []);

    useEffect(() => {
        if (!url || url === '') return;
        console.log("fetching captions for url: " + url + "...");

        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.send();
        xhr.onreadystatechange = function () {
            if (this.readyState === 4 && this.status === 200) {
                console.log(this.responseText);
                setCaptions(JSON.parse(this.responseText));
            }
        }
    }, [url]);

    useEffect(() => {
        for (let i = 0; i < captions.length; i++) {
            // Create a new HTMLTrackElement
            const trackElement = document.createElement('track');

            trackElement.src = captions[i].base_url;
            trackElement.kind = 'captions';
            trackElement.label = captions[i].name.text;
            trackElement.srclang = captions[i].language_code;

            // TODO ref
            document.getElementsByTagName('video')[0].appendChild(trackElement);
        }
    }, [captions]);

    return (
        <>
            {/* {captions.map((track, index) => (
                <track
                    key={index}
                    src={track.base_url}
                    kind="captions"
                    label={track.name.text}
                    srclang={track.language_code}
                />
            ))} */}
            <div></div>
        </>
    )
}
