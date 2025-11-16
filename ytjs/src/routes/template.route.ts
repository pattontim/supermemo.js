import { existsSync, readFileSync } from "fs";
import path from "path";
import { app, fullUrlForClient } from "../server";
import { ElementInfo } from "../utils/element";


app.get("/templateUrl/:id", async (req, res) => {
	const id = req.params.id;
	if (id.length == 11) {
		console.log("11 len ID detected, returning the player");
		res.send(`http://${fullUrlForClient}/templates/smplayer.html`);
		return;
	}

	// open FS at elements/id and read info.json, return its HTML
	// patch together and send
	const dir = path.join(elementsDir, id);
	if (!existsSync(dir)) {
		res.status(404).send("Not found: " + dir);
		return;
	}
	const info = JSON.parse(
		readFileSync(path.join(dir, "info.json"), "utf-8")
	) as ElementInfo;

	// open at templates/id.html and ret the template
	// const template = JSON.parse(readFileSync(path.join(archiveDir, 'templates', info.templateId + '.json'), 'utf-8'));
	res.send(`http://${fullUrlForClient}/templates/${info.templateId}.html`);
});export let elementsDir = "./dist/elements";

