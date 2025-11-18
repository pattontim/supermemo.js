// @ts-expect-error it exists
import corsAnywhere from "cors-anywhere";
import { spawn } from "child_process";
import { Router } from "express";

const router = Router();

const proxy = corsAnywhere.createServer({
	originWhitelist: [], // Allow all origins
	requireHeaders: [], // Do not require any headers.
	removeHeaders: [], // Do not remove any headers.
});

/* Attach our cors proxy to the existing API on the /proxy endpoint. */
router.get("/proxy/:proxyUrl*", async (req, res) => {
	req.url = req.url.replace("/proxy/", "/"); // Strip '/proxy' from the front of the URL, else the proxy won't work.
	proxy.emit("request", req, res);
});
router.get("/magnify", async (req, res) => {
	res.send("Magnify!");
	const dir = spawn("cmd", ["/c", "magnify"]);

	dir.stdout.on("data", (data) => console.log(`stdout: ${data}`));
	dir.stderr.on("data", (data) => console.log(`stderr: ${data}`));
	dir.on("close", (code) => console.log(`child process exited with code ${code}`)
	);
});

export default router;