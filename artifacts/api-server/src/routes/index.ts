import { Router, type IRouter } from "express";
import healthRouter from "./health";
import trakcareRouter from "./trakcare";
import cloudRouter from "./cloud";
import ktmRouter from "./ktm";

const router: IRouter = Router();

router.use(healthRouter);
router.use(trakcareRouter);
router.use(cloudRouter);
router.use(ktmRouter);

export default router;
