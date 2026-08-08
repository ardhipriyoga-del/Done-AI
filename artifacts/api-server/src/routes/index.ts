import { Router, type IRouter } from "express";
import healthRouter from "./health";
import trakcareRouter from "./trakcare";
import cloudRouter from "./cloud";
import ktmRouter from "./ktm";
import whatsappRouter from "./whatsapp";

const router: IRouter = Router();

router.use(healthRouter);
router.use(trakcareRouter);
router.use(cloudRouter);
router.use(ktmRouter);
router.use(whatsappRouter);

export default router;
