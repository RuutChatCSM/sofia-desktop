import {
  OrganizationInviteEmail,
  type OrganizationInviteEmailProps,
} from "../src/templates/organization-invite"

export default function OrganizationInvitePreview(props: OrganizationInviteEmailProps) {
  return <OrganizationInviteEmail {...props} />
}

OrganizationInvitePreview.PreviewProps = {
  inviteLink: "https://sofia-app.ruut.chat/join-org?invite=invitation_preview",
  invitedByName: "Ada Lovelace",
  invitedByEmail: "ada@example.com",
  organizationName: "Sofia Preview",
  role: "admin",
} satisfies OrganizationInviteEmailProps
