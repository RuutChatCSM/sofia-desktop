import Image from "next/image";

type Props = {
  className?: string;
};

export function SofiaMark(props: Props) {
  return (
    <Image
      src="/sofia-mark.svg"
      alt=""
      aria-hidden="true"
      className={props.className}
      width={1254}
      height={1254}
      unoptimized
    />
  );
}
